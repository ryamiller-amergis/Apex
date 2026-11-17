import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReleaseView from '../ReleaseView';
import type { WorkItem } from '../../types/workitem';
import type {
  ProjectReleasePlatformsState,
  ReleasePlatform,
} from '../../../shared/types/releasePlatforms';

let mockIsInAnyGroup = jest.fn(() => true);

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    isInAnyGroup: mockIsInAnyGroup,
    permissionsLoaded: true,
    can: () => true,
  }),
}));

const okResponse = (data: unknown, status = 200) =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => data,
  });

const EPICS = [
  {
    id: 101,
    version: '2026.11 Core',
    status: 'In Progress',
    startDate: '2026-11-01',
    targetDate: '2026-11-25',
    description: 'Desktop and Mobile synchronization',
    progress: 50,
    completedItems: 2,
    totalItems: 4,
    greenItems: 2,
    amberItems: 1,
    redItems: 1,
    childItemsSummary: [
      { id: 501, state: 'Ready For Release', tags: 'Desktop' },
      { id: 502, state: 'Done', tags: 'Desktop; Mobile' },
      { id: 503, state: 'UAT - Ready For Test', tags: 'Mobile' },
      { id: 504, state: 'In Progress', tags: '' },
    ],
  },
  {
    id: 102,
    version: '2026.12 Planned',
    status: 'New',
    startDate: '2026-12-01',
    targetDate: '2026-12-18',
    description: 'Mobile camera capture',
    progress: 0,
    completedItems: 0,
    totalItems: 1,
    greenItems: 0,
    amberItems: 1,
    redItems: 0,
    childItemsSummary: [{ id: 601, state: 'UAT - Ready For Test', tags: 'Mobile' }],
  },
  {
    id: 103,
    version: '2026.10 Shipped',
    status: 'Done',
    startDate: '2026-10-01',
    targetDate: '2026-10-15',
    description: 'Completed autumn release',
    progress: 100,
    completedItems: 3,
    totalItems: 3,
    greenItems: 3,
    amberItems: 0,
    redItems: 0,
    childItemsSummary: [],
  },
];

const EPIC_101_ITEMS: WorkItem[] = [
  {
    id: 501,
    title: 'Desktop Shell Auto-Updater',
    state: 'Ready For Release',
    workItemType: 'Feature',
    assignedTo: 'Alex Dev',
    tags: 'Desktop',
    changedDate: '2026-11-10',
    createdDate: '2026-11-01',
    areaPath: 'MaxView',
    iterationPath: 'MaxView\\Sprint 1',
  },
  {
    id: 502,
    title: 'Shared Auth Token Refresh',
    state: 'Done',
    workItemType: 'Product Backlog Item',
    assignedTo: 'Sam Eng',
    tags: 'Desktop; Mobile',
    changedDate: '2026-11-10',
    createdDate: '2026-11-01',
    areaPath: 'MaxView',
    iterationPath: 'MaxView\\Sprint 1',
  },
  {
    id: 503,
    title: 'Mobile Offline Queue',
    state: 'UAT - Ready For Test',
    workItemType: 'Product Backlog Item',
    assignedTo: 'Jamie QA',
    tags: 'Mobile',
    changedDate: '2026-11-11',
    createdDate: '2026-11-01',
    areaPath: 'MaxView',
    iterationPath: 'MaxView\\Sprint 1',
  },
  {
    id: 504,
    title: 'Crash Telemetry Hook',
    state: 'In Progress',
    workItemType: 'Bug',
    assignedTo: 'Taylor Dev',
    tags: '',
    changedDate: '2026-11-12',
    createdDate: '2026-11-02',
    areaPath: 'MaxView',
    iterationPath: 'MaxView\\Sprint 1',
  },
];

function createStatefulPlatformFetch(initialPlatforms: ReleasePlatform[] = []) {
  const state: ProjectReleasePlatformsState = {
    project: 'MaxView',
    platforms: [...initialPlatforms],
    epicPlatformIds: {},
    workItemPlatformIds: {},
  };

  return jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.startsWith('/api/releases/epics')) {
      return okResponse(EPICS);
    }
    if (url.startsWith('/api/releases/platforms') && method === 'GET') {
      return okResponse({
        project: state.project,
        platforms: [...state.platforms],
        epicPlatformIds: { ...state.epicPlatformIds },
        workItemPlatformIds: { ...state.workItemPlatformIds },
      });
    }
    if (url === '/api/releases/platforms' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const slug = String(body.name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-');
      const created: ReleasePlatform = {
        id: `plat-${slug}`,
        project: body.project,
        slug,
        name: body.name,
        color: body.color ?? 'blue',
        sortOrder: state.platforms.length,
        createdAt: '2026-11-13T00:00:00.000Z',
      };
      state.platforms = [...state.platforms, created];
      return okResponse(created, 201);
    }
    const itemPlatMatch = url.match(/\/api\/releases\/work-items\/(\d+)\/platforms/);
    if (itemPlatMatch && method === 'PUT') {
      const workItemId = Number(itemPlatMatch[1]);
      const body = JSON.parse(String(init?.body ?? '{}'));
      state.workItemPlatformIds = {
        ...state.workItemPlatformIds,
        [workItemId]: body.platformIds,
      };
      return okResponse({
        success: true,
        workItemId,
        platformIds: body.platformIds,
      });
    }
    if (url.includes('/api/releases/101/related-items')) {
      return okResponse(EPIC_101_ITEMS);
    }
    if (url.startsWith('/api/releases?')) {
      return okResponse([]);
    }
    return okResponse([]);
  });
}

const renderReleaseView = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReleaseView workItems={[]} project="MaxView" areaPath="MaxView" />
    </QueryClientProvider>,
  );
};

describe('ReleaseView — Slated Overview, Platform Matrix, Organization & QA Validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsInAnyGroup = jest.fn(() => true);
  });

  it('hides platform noise when 0 platforms are configured and allows creating Desktop & Mobile via Manage Platforms', async () => {
    global.fetch = createStatefulPlatformFetch([]) as unknown as typeof fetch;
    renderReleaseView();

    await screen.findByText('2026.11 Core');

    // Slated overview renders accurately for the 2 slated releases (101 + 102)
    const overview = screen.getByTestId('release-slated-overview');
    expect(within(overview).getByTestId('slated-releases-count')).toHaveTextContent('2');
    expect(within(overview).getByTestId('slated-overall-progress')).toHaveTextContent('40%'); // 2 green / 5 total
    expect(within(overview).getByTestId('slated-left-to-validate')).toHaveTextContent('3');
    expect(within(overview).getByTestId('slated-left-to-validate')).toHaveTextContent('2 UAT ready now');
    expect(within(overview).getByTestId('slated-left-to-validate')).toHaveTextContent('1 in dev');

    // No platform breakdown or platform filter pills when 0 platforms configured
    expect(screen.queryByTestId('slated-platform-breakdown')).not.toBeInTheDocument();
    expect(screen.queryByTestId('release-platform-filter-all')).not.toBeInTheDocument();

    // Open Manage Platforms modal and add Desktop + Mobile presets
    fireEvent.click(screen.getByTestId('release-manage-platforms-btn'));
    const modal = await screen.findByTestId('release-platforms-modal');
    fireEvent.click(within(modal).getByTestId('release-platform-preset-desktop'));
    await waitFor(() =>
      expect(within(modal).getByTestId('release-platform-row-desktop')).toBeInTheDocument(),
    );
    fireEvent.click(within(modal).getByTestId('release-platform-preset-mobile'));
    await waitFor(() =>
      expect(within(modal).getByTestId('release-platform-row-mobile')).toBeInTheDocument(),
    );
    fireEvent.click(within(modal).getByTestId('release-platforms-modal-done'));

    // Platform readiness matrix now appears with Desktop & Mobile chips
    const breakdown = await screen.findByTestId('slated-platform-breakdown');
    expect(within(breakdown).getByTestId('slated-platform-chip-desktop')).toHaveTextContent(
      'Desktop',
    );
    expect(within(breakdown).getByTestId('slated-platform-chip-mobile')).toHaveTextContent(
      'Mobile',
    );
    expect(within(breakdown).getByTestId('slated-platform-chip-mobile')).toHaveTextContent(
      '2 left to validate',
    );
  });

  it('filters releases by Lifecycle (Slated, In Flight, Shipped) and groups by Lifecycle Stage & Target Platform', async () => {
    const initialPlatforms: ReleasePlatform[] = [
      {
        id: 'plat-desktop',
        project: 'MaxView',
        slug: 'desktop',
        name: 'Desktop',
        color: 'blue',
        sortOrder: 0,
        createdAt: '2026-11-13T00:00:00.000Z',
      },
      {
        id: 'plat-mobile',
        project: 'MaxView',
        slug: 'mobile',
        name: 'Mobile',
        color: 'purple',
        sortOrder: 1,
        createdAt: '2026-11-13T00:01:00.000Z',
      },
    ];
    global.fetch = createStatefulPlatformFetch(initialPlatforms) as unknown as typeof fetch;
    renderReleaseView();

    await screen.findByText('2026.11 Core');
    expect(screen.getByText('2026.10 Shipped')).toBeInTheDocument();

    // Filter to Slated — hides shipped Done release
    fireEvent.click(screen.getByTestId('release-lifecycle-filter-slated'));
    expect(screen.getByText('2026.11 Core')).toBeInTheDocument();
    expect(screen.getByText('2026.12 Planned')).toBeInTheDocument();
    expect(screen.queryByText('2026.10 Shipped')).not.toBeInTheDocument();

    // Filter to In Flight — shows only In Progress release
    fireEvent.click(screen.getByTestId('release-lifecycle-filter-in-flight'));
    expect(screen.getByText('2026.11 Core')).toBeInTheDocument();
    expect(screen.queryByText('2026.12 Planned')).not.toBeInTheDocument();

    // Filter to Shipped — shows only Done release
    fireEvent.click(screen.getByTestId('release-lifecycle-filter-shipped'));
    expect(screen.getByText('2026.10 Shipped')).toBeInTheDocument();
    expect(screen.queryByText('2026.11 Core')).not.toBeInTheDocument();

    // Reset to All and group by Lifecycle Stage
    fireEvent.click(screen.getByTestId('release-lifecycle-filter-all'));
    fireEvent.change(screen.getByTestId('release-group-by'), {
      target: { value: 'lifecycle' },
    });
    expect(screen.getByTestId('release-group-section-in-flight')).toBeInTheDocument();
    expect(screen.getByTestId('release-group-section-planned')).toBeInTheDocument();
    expect(screen.getByTestId('release-group-section-shipped')).toBeInTheDocument();

    // Group by Target Platform
    fireEvent.change(screen.getByTestId('release-group-by'), {
      target: { value: 'platform' },
    });
    expect(screen.getByTestId('release-group-section-desktop')).toBeInTheDocument();
    expect(screen.getByTestId('release-group-section-mobile')).toBeInTheDocument();
    expect(screen.getByTestId('release-group-section-unassigned')).toBeInTheDocument();
  });

  it('supports expanded release QA validation filters, item grouping, and assigning platforms to a work item', async () => {
    const initialPlatforms: ReleasePlatform[] = [
      {
        id: 'plat-desktop',
        project: 'MaxView',
        slug: 'desktop',
        name: 'Desktop',
        color: 'blue',
        sortOrder: 0,
        createdAt: '2026-11-13T00:00:00.000Z',
      },
      {
        id: 'plat-mobile',
        project: 'MaxView',
        slug: 'mobile',
        name: 'Mobile',
        color: 'purple',
        sortOrder: 1,
        createdAt: '2026-11-13T00:01:00.000Z',
      },
    ];
    global.fetch = createStatefulPlatformFetch(initialPlatforms) as unknown as typeof fetch;
    renderReleaseView();

    await screen.findByText('2026.11 Core');
    await screen.findByTestId('slated-platform-breakdown');

    // Row remaining badge shows "2 left" and "1 UAT ready"
    expect(screen.getByTestId('release-remaining-badge-101')).toHaveTextContent('2 left');
    expect(screen.getByTestId('release-remaining-badge-101')).toHaveTextContent('1 UAT ready');

    // Expand 2026.11 Core
    fireEvent.click(screen.getByTestId('release-expand-101'));
    await screen.findByText('Desktop Shell Auto-Updater');

    // Filter expanded items to UAT Ready
    fireEvent.click(screen.getByTestId('release-item-filter-101-uat-ready'));
    expect(screen.getByText('Mobile Offline Queue')).toBeInTheDocument();
    expect(screen.queryByText('Desktop Shell Auto-Updater')).not.toBeInTheDocument();

    // Filter expanded items to Left to Validate (amber + red)
    fireEvent.click(screen.getByTestId('release-item-filter-101-left-to-validate'));
    expect(screen.getByText('Mobile Offline Queue')).toBeInTheDocument();
    expect(screen.getByText('Crash Telemetry Hook')).toBeInTheDocument();
    expect(screen.queryByText('Shared Auth Token Refresh')).not.toBeInTheDocument();

    // Reset item filter to All and group by Validation Status
    fireEvent.click(screen.getByTestId('release-item-filter-101-all'));
    fireEvent.change(screen.getByTestId('release-item-group-by-101'), {
      target: { value: 'validation' },
    });
    expect(screen.getByTestId('release-item-section-101-amber')).toBeInTheDocument();
    expect(screen.getByTestId('release-item-section-101-red')).toBeInTheDocument();
    expect(screen.getByTestId('release-item-section-101-green')).toBeInTheDocument();

    // Switch item grouping to Platform
    fireEvent.change(screen.getByTestId('release-item-group-by-101'), {
      target: { value: 'platform' },
    });
    expect(screen.getByTestId('release-item-section-101-desktop')).toBeInTheDocument();
    expect(screen.getByTestId('release-item-section-101-mobile')).toBeInTheDocument();
    expect(screen.getByTestId('release-item-section-101-unassigned')).toBeInTheDocument();

    // Assign Desktop platform to unassigned bug #504 via its card popover
    fireEvent.click(screen.getByTestId('release-item-platform-btn-101-504'));
    fireEvent.click(screen.getByTestId('release-item-platform-opt-101-504-desktop'));

    await waitFor(() => {
      expect(screen.queryByTestId('release-item-section-101-unassigned')).not.toBeInTheDocument();
      expect(screen.getByTestId('release-expanded-platform-101-desktop')).toHaveTextContent(
        'Desktop: 2/3 ready · 1 left',
      );
    });
  });
});
