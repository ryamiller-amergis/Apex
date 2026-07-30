import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WalkthroughAnchorManagement } from '../WalkthroughAnchorManagement';
import { WalkthroughsAdminPanel } from '../WalkthroughsAdminPanel';
import {
  MOCK_WALKTHROUGH_ANCHOR_REGISTRY,
  MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES,
  computeAnchorCatalogCounts,
  filterAnchorCatalog,
} from '../walkthroughAnchorManagementMockData';
import type { WalkthroughAnchorRegistryRecord } from '../../../shared/types/walkthroughAnchorRegistry';
import {
  useAnchorRegistryCatalog,
  useAnchorRegistryModuleCoverage,
  useBulkUpdateAnchors,
  useCreateManualAnchor,
  useSoftDeleteAnchor,
  useSyncAnchorRegistry,
  useUpdateAnchorRegistry,
} from '../../hooks/usePlatformAdminAnchorRegistry';

jest.mock('../WalkthroughCatalog', () => ({
  WalkthroughCatalog: () => <div data-testid="walkthrough-catalog" />,
}));

jest.mock('../../hooks/usePlatformAdminAnchorRegistry', () => ({
  ...jest.requireActual('../../hooks/usePlatformAdminAnchorRegistry'),
  useAnchorRegistryCatalog: jest.fn(),
  useAnchorRegistryModuleCoverage: jest.fn(),
  useCreateManualAnchor: jest.fn(),
  useUpdateAnchorRegistry: jest.fn(),
  useBulkUpdateAnchors: jest.fn(),
  useSoftDeleteAnchor: jest.fn(),
  useSyncAnchorRegistry: jest.fn(),
  startAndPollAnchorSmartTagging: jest.fn().mockResolvedValue(null),
}));

const mockUseAnchorRegistryCatalog = useAnchorRegistryCatalog as jest.Mock;
const mockUseAnchorRegistryModuleCoverage = useAnchorRegistryModuleCoverage as jest.Mock;
const mockUseCreateManualAnchor = useCreateManualAnchor as jest.Mock;
const mockUseUpdateAnchorRegistry = useUpdateAnchorRegistry as jest.Mock;
const mockUseBulkUpdateAnchors = useBulkUpdateAnchors as jest.Mock;
const mockUseSoftDeleteAnchor = useSoftDeleteAnchor as jest.Mock;
const mockUseSyncAnchorRegistry = useSyncAnchorRegistry as jest.Mock;

function mutationStub(overrides: Record<string, unknown> = {}) {
  return {
    mutateAsync: jest.fn().mockResolvedValue({}),
    isPending: false,
    error: null,
    ...overrides,
  };
}

function stubHooks(options?: {
  items?: readonly WalkthroughAnchorRegistryRecord[];
  syncResult?: {
    candidates?: readonly WalkthroughAnchorRegistryRecord[];
    persistence?: {
      created: readonly WalkthroughAnchorRegistryRecord[];
      refreshed?: readonly WalkthroughAnchorRegistryRecord[];
      markedMissing?: readonly WalkthroughAnchorRegistryRecord[];
      newCandidateIdsForSmartTagging?: string[];
    };
  };
}) {
  const items = options?.items ?? MOCK_WALKTHROUGH_ANCHOR_REGISTRY;
  const counts = computeAnchorCatalogCounts(items);
  mockUseAnchorRegistryCatalog.mockReturnValue({
    data: {
      items: [...items],
      nextCursor: null,
      counts: {
        total: counts.total,
        pending: counts.pending,
        approved: counts.approved,
        rejected: counts.rejected,
        active: items.filter((r) => r.isActive).length,
        missing: counts.missing,
      },
    },
    isLoading: false,
    isError: false,
    error: null,
  });
  mockUseAnchorRegistryModuleCoverage.mockReturnValue({
    data: {
      totalModules: 3,
      coveredCount: 2,
      uncoveredCount: 1,
      coveredModules: [
        { key: 'home', label: 'Home', anchorCount: 3, routes: ['/home'] },
        { key: 'profile', label: 'Profile', anchorCount: 4, routes: ['/profile'] },
      ],
      uncoveredModules: [
        {
          key: 'planning',
          label: 'Planning',
          anchorCount: 0,
          routes: ['/planning/dev-stats', '/planning/qa'],
        },
      ],
    },
    isLoading: false,
    isError: false,
    error: null,
  });
  mockUseCreateManualAnchor.mockReturnValue(mutationStub());
  mockUseUpdateAnchorRegistry.mockReturnValue(mutationStub());
  mockUseBulkUpdateAnchors.mockReturnValue(mutationStub());
  mockUseSoftDeleteAnchor.mockReturnValue(mutationStub());
  const syncCandidates =
    options?.syncResult?.persistence?.created ??
    options?.syncResult?.candidates ??
    MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES;
  mockUseSyncAnchorRegistry.mockReturnValue(
    mutationStub({
      mutateAsync: jest.fn().mockResolvedValue({
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
          created: [...syncCandidates],
          refreshed: [],
          markedMissing: [],
          reviewCandidates: [...syncCandidates],
          newCandidateIdsForSmartTagging: syncCandidates.map((c) => c.id),
          ...options?.syncResult?.persistence,
        },
        candidates: options?.syncResult?.candidates,
      }),
    }),
  );
}

describe('walkthroughAnchorManagementMockData', () => {
  it('includes baseline seeds plus missing/rejected examples (no pending in catalog grid)', () => {
    const counts = computeAnchorCatalogCounts(MOCK_WALKTHROUGH_ANCHOR_REGISTRY);
    expect(counts.approved).toBeGreaterThanOrEqual(7);
    expect(counts.pending).toBe(0);
    expect(counts.missing).toBeGreaterThanOrEqual(1);
    expect(
      MOCK_WALKTHROUGH_ANCHOR_REGISTRY.some((r) => r.anchorKey === 'user-menu-trigger'),
    ).toBe(true);
    expect(MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES.every((r) => r.reviewStatus === 'pending')).toBe(
      true,
    );
  });

  it('filters by status, route, source, presence, and search', () => {
    const approved = filterAnchorCatalog(MOCK_WALKTHROUGH_ANCHOR_REGISTRY, {
      search: '',
      status: 'approved',
      route: '',
      source: 'all',
      presence: 'all',
    });
    expect(approved.every((r) => r.reviewStatus === 'approved')).toBe(true);

    const profile = filterAnchorCatalog(MOCK_WALKTHROUGH_ANCHOR_REGISTRY, {
      search: 'profile-bio',
      status: 'all',
      route: '/profile',
      source: 'explicit',
      presence: 'present',
    });
    expect(profile.some((r) => r.anchorKey === 'profile-bio')).toBe(true);

    const missing = filterAnchorCatalog(MOCK_WALKTHROUGH_ANCHOR_REGISTRY, {
      search: '',
      status: 'all',
      route: '',
      source: 'all',
      presence: 'missing',
    });
    expect(missing.every((r) => r.missingSince != null)).toBe(true);
  });
});

describe('WalkthroughsAdminPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stubHooks();
  });

  it('nests Walkthroughs and Anchor Management sub-tabs', async () => {
    const user = userEvent.setup();
    render(<WalkthroughsAdminPanel />);

    expect(screen.getByTestId('walkthroughs-admin-panel')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-catalog')).toBeInTheDocument();
    expect(screen.queryByTestId('walkthrough-anchor-management')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('walkthroughs-admin-tab-anchors'));

    expect(screen.getByTestId('walkthrough-anchor-management')).toBeInTheDocument();
    expect(screen.queryByTestId('walkthrough-catalog')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('walkthroughs-admin-tab-walkthroughs'));
    expect(screen.getByTestId('walkthrough-catalog')).toBeInTheDocument();
  });
});

describe('WalkthroughAnchorManagement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stubHooks();
  });

  it('renders status/presence counts and catalog rows from hook catalog', () => {
    render(<WalkthroughAnchorManagement />);

    const counts = computeAnchorCatalogCounts(MOCK_WALKTHROUGH_ANCHOR_REGISTRY);
    const countsEl = screen.getByTestId('walkthrough-anchor-counts');
    expect(countsEl).toHaveTextContent(String(counts.total));
    expect(countsEl).not.toHaveTextContent(/Pending/);
    expect(countsEl).toHaveTextContent(String(counts.missing));

    expect(screen.getByTestId('walkthrough-anchor-table')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-anchor-row-anchor-seed-01')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-anchor-missing-anchor-missing-01')).toHaveTextContent(
      'missing',
    );
  });

  it('keeps module coverage compact until the user expands its details', async () => {
    const user = userEvent.setup();
    render(<WalkthroughAnchorManagement />);

    const coverage = screen.getByTestId('walkthrough-module-coverage');
    expect(within(coverage).getByText('2 of 3 covered')).toBeInTheDocument();
    expect(within(coverage).getByText('1 module needs anchors')).toBeInTheDocument();
    expect(coverage).not.toHaveAttribute('open');

    await user.click(within(coverage).getByText('Module coverage'));

    expect(coverage).toHaveAttribute('open');
    expect(screen.getByTestId('walkthrough-module-covered-home')).toHaveTextContent(
      'Home3 anchors',
    );
    expect(screen.getByTestId('walkthrough-module-covered-profile')).toHaveTextContent(
      'Profile4 anchors',
    );
    expect(screen.getByTestId('walkthrough-module-uncovered-planning')).toHaveTextContent(
      'Planning/planning/dev-stats, /planning/qa',
    );
  });

  it('honors records prop override for tests', () => {
    const subset = [MOCK_WALKTHROUGH_ANCHOR_REGISTRY[0]];
    render(<WalkthroughAnchorManagement records={subset} />);
    expect(screen.getByTestId(`walkthrough-anchor-row-${subset[0].id}`)).toBeInTheDocument();
    expect(screen.queryByTestId('walkthrough-anchor-row-anchor-pending-01')).not.toBeInTheDocument();
  });

  it('filters the grid by search and status when using records override', async () => {
    const user = userEvent.setup();
    render(<WalkthroughAnchorManagement records={MOCK_WALKTHROUGH_ANCHOR_REGISTRY} />);

    await user.type(screen.getByTestId('walkthrough-anchor-search'), 'standup-submit');
    expect(screen.getByTestId('walkthrough-anchor-row-anchor-missing-01')).toBeInTheDocument();
    expect(screen.queryByTestId('walkthrough-anchor-row-anchor-seed-01')).not.toBeInTheDocument();

    await user.clear(screen.getByTestId('walkthrough-anchor-search'));
    await user.selectOptions(screen.getByTestId('walkthrough-anchor-filter-status'), 'rejected');

    const rows = screen.getAllByTestId(/walkthrough-anchor-row-/);
    expect(rows.length).toBe(1);
    expect(within(rows[0]).getByText('rejected')).toBeInTheDocument();
  });

  it('shows empty state when filters match nothing', async () => {
    const user = userEvent.setup();
    render(<WalkthroughAnchorManagement records={MOCK_WALKTHROUGH_ANCHOR_REGISTRY} />);

    await user.type(screen.getByTestId('walkthrough-anchor-search'), 'zzz-no-such-anchor');
    expect(screen.getByTestId('walkthrough-anchor-empty')).toBeInTheDocument();
  });

  it('opens Add New modal and submits create mutation', async () => {
    const user = userEvent.setup();
    const createAsync = jest.fn().mockResolvedValue({ id: 'new-1' });
    mockUseCreateManualAnchor.mockReturnValue(mutationStub({ mutateAsync: createAsync }));

    render(<WalkthroughAnchorManagement records={MOCK_WALKTHROUGH_ANCHOR_REGISTRY} />);

    await user.click(screen.getByTestId('walkthrough-anchor-add-new'));
    expect(screen.getByTestId('walkthrough-anchor-add-modal')).toBeInTheDocument();

    await user.type(screen.getByTestId('walkthrough-anchor-add-key'), 'feature-request-fab');
    await user.type(screen.getByTestId('walkthrough-anchor-add-testid'), 'feature-request-fab');
    await user.type(screen.getByTestId('walkthrough-anchor-add-label'), 'Feature request FAB');
    await user.click(screen.getByTestId('walkthrough-anchor-add-save'));

    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    expect(createAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorKey: 'feature-request-fab',
        testId: 'feature-request-fab',
        label: 'Feature request FAB',
        reviewStatus: 'approved',
        isActive: true,
      }),
    );
    expect(screen.queryByTestId('walkthrough-anchor-add-modal')).not.toBeInTheDocument();
  });

  it('opens Sync via sync mutation and saves with bulk approve/reject/activate', async () => {
    const user = userEvent.setup();
    const syncAsync = jest.fn().mockResolvedValue({
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
        created: MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES,
        refreshed: [],
        markedMissing: [],
        reviewCandidates: MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES,
        newCandidateIdsForSmartTagging: MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES.map((c) => c.id),
      },
    });
    const updateAsync = jest.fn().mockResolvedValue({});
    const bulkAsync = jest.fn().mockResolvedValue({ items: [] });
    mockUseSyncAnchorRegistry.mockReturnValue(mutationStub({ mutateAsync: syncAsync }));
    mockUseUpdateAnchorRegistry.mockReturnValue(mutationStub({ mutateAsync: updateAsync }));
    mockUseBulkUpdateAnchors.mockReturnValue(mutationStub({ mutateAsync: bulkAsync }));

    render(<WalkthroughAnchorManagement />);

    await user.click(screen.getByTestId('walkthrough-anchor-sync'));
    await waitFor(() =>
      expect(screen.getByTestId('walkthrough-anchor-sync-modal')).toBeInTheDocument(),
    );
    expect(syncAsync).toHaveBeenCalled();

    const first = MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES[0];
    expect(screen.getByTestId(`walkthrough-anchor-sync-row-${first.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`walkthrough-anchor-row-${first.id}`)).not.toBeInTheDocument();

    await user.click(screen.getByTestId('walkthrough-anchor-sync-approve-all'));
    await user.click(screen.getByTestId('walkthrough-anchor-sync-save'));

    await waitFor(() => expect(bulkAsync).toHaveBeenCalled());
    expect(updateAsync).toHaveBeenCalled();
    expect(bulkAsync).toHaveBeenCalledWith({
      ids: MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES.map((c) => c.id),
      action: 'approve',
    });
    expect(bulkAsync).toHaveBeenCalledWith({
      ids: MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES.map((c) => c.id),
      action: 'activate',
    });
    expect(screen.queryByTestId('walkthrough-anchor-sync-modal')).not.toBeInTheDocument();
  });

  it('uses syncCandidates prop override without calling sync API', async () => {
    const user = userEvent.setup();
    const onSyncSave = jest.fn();
    const syncAsync = jest.fn();
    mockUseSyncAnchorRegistry.mockReturnValue(mutationStub({ mutateAsync: syncAsync }));
    const candidates = MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES;

    render(
      <WalkthroughAnchorManagement
        records={MOCK_WALKTHROUGH_ANCHOR_REGISTRY}
        syncCandidates={candidates}
        onSyncSave={onSyncSave}
      />,
    );

    await user.click(screen.getByTestId('walkthrough-anchor-sync'));
    expect(syncAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId('walkthrough-anchor-sync-modal')).toBeInTheDocument();

    const first = candidates[0];
    await user.clear(screen.getByTestId(`walkthrough-anchor-sync-label-${first.id}`));
    await user.type(
      screen.getByTestId(`walkthrough-anchor-sync-label-${first.id}`),
      'Updated label',
    );
    await user.click(screen.getByTestId('walkthrough-anchor-sync-save'));

    await waitFor(() => expect(onSyncSave).toHaveBeenCalled());
    const saved = onSyncSave.mock.calls[0][0] as Array<{ id: string; label: string }>;
    expect(saved.find((d) => d.id === first.id)?.label).toBe('Updated label');
  });

  it('opens edit modal and posts update mutation', async () => {
    const user = userEvent.setup();
    const updateAsync = jest.fn().mockResolvedValue({});
    mockUseUpdateAnchorRegistry.mockReturnValue(mutationStub({ mutateAsync: updateAsync }));
    const subset: WalkthroughAnchorRegistryRecord[] = [MOCK_WALKTHROUGH_ANCHOR_REGISTRY[0]];

    render(<WalkthroughAnchorManagement records={subset} />);

    const id = subset[0].id;
    await user.click(screen.getByTestId(`walkthrough-anchor-edit-${id}`));
    expect(screen.getByTestId('walkthrough-anchor-edit-modal')).toBeInTheDocument();

    await user.clear(screen.getByTestId('walkthrough-anchor-edit-label'));
    await user.type(screen.getByTestId('walkthrough-anchor-edit-label'), 'Renamed anchor');
    await user.click(screen.getByTestId('walkthrough-anchor-edit-save'));

    await waitFor(() => expect(updateAsync).toHaveBeenCalled());
    expect(updateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id,
        label: 'Renamed anchor',
      }),
    );
  });

  it('opens delete confirm and soft-deletes', async () => {
    const user = userEvent.setup();
    const deleteAsync = jest.fn().mockResolvedValue({});
    mockUseSoftDeleteAnchor.mockReturnValue(mutationStub({ mutateAsync: deleteAsync }));
    const subset: WalkthroughAnchorRegistryRecord[] = [MOCK_WALKTHROUGH_ANCHOR_REGISTRY[0]];

    render(<WalkthroughAnchorManagement records={subset} />);

    const id = subset[0].id;
    await user.click(screen.getByTestId(`walkthrough-anchor-delete-${id}`));
    expect(screen.getByTestId('walkthrough-anchor-delete-modal')).toBeInTheDocument();
    await user.click(screen.getByTestId('walkthrough-anchor-delete-confirm'));

    await waitFor(() => expect(deleteAsync).toHaveBeenCalledWith({ id }));
  });

  it('renders tag chips, placement badges, and source paths without line numbers', () => {
    const record = MOCK_WALKTHROUGH_ANCHOR_REGISTRY.find(
      (r) => r.anchorKey === 'user-menu-trigger',
    )!;
    const withLine: WalkthroughAnchorRegistryRecord = {
      ...record,
      sourceLocations: [
        {
          filePath: 'src/client/components/UserMenu.tsx',
          line: 99,
          discoveryKind: 'explicit',
        },
      ],
    };
    render(<WalkthroughAnchorManagement records={[withLine]} />);

    const row = screen.getByTestId(`walkthrough-anchor-row-${withLine.id}`);
    expect(within(row).getByText('user-menu')).toBeInTheDocument();
    expect(within(row).getByText('bottom')).toBeInTheDocument();
    expect(
      within(row).getByText('src/client/components/UserMenu.tsx'),
    ).toBeInTheDocument();
    expect(within(row).queryByText(/UserMenu\.tsx:99/)).not.toBeInTheDocument();
  });
});
