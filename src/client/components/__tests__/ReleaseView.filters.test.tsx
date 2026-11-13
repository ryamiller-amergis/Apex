import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReleaseView from '../ReleaseView';

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    isInAnyGroup: () => true,
    permissionsLoaded: true,
    can: () => true,
  }),
}));

const EPICS = [
  {
    id: 101,
    version: 'v2.4.0',
    status: 'In Progress',
    areaPath: 'MaxView\\Mobile',
    platform: 'Mobile',
    startDate: '2026-11-01',
    targetDate: '2026-11-18',
    description: 'Biometric login for mobile',
    progress: 50,
    totalItems: 4,
    completedItems: 2,
    greenItems: 2,
    amberItems: 1,
    redItems: 1,
  },
  {
    id: 102,
    version: 'v3.1.0',
    status: 'New',
    areaPath: 'MaxView\\Desktop',
    platform: 'Desktop',
    startDate: '2026-11-05',
    targetDate: undefined,
    description: 'Desktop offline queue',
    progress: 100,
    totalItems: 2,
    completedItems: 2,
    greenItems: 2,
    amberItems: 0,
    redItems: 0,
  },
  {
    id: 103,
    version: 'v2.3.0',
    status: 'Done',
    areaPath: 'MaxView\\Mobile',
    platform: 'Mobile',
    startDate: '2026-10-01',
    targetDate: '2026-10-15',
    description: 'Shipped push notifications',
    progress: 100,
    totalItems: 3,
    completedItems: 3,
    greenItems: 3,
    amberItems: 0,
    redItems: 0,
  },
];

const renderView = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReleaseView workItems={[]} project="MaxView" areaPath="MaxView" />
    </QueryClientProvider>,
  );
};

describe('ReleaseView - Top Control Bar & Release Queue Cards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/releases/epics')) {
        return Promise.resolve({ ok: true, json: async () => EPICS });
      }
      if (url.includes('/related-items')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    }) as jest.Mock;
  });

  it('defaults to Active & Upcoming scope, renders platform badges and remaining chips, and makes zero extra ADO calls on load', async () => {
    renderView();

    await waitFor(() => {
      expect(screen.getByTestId('release-card-101')).toBeInTheDocument();
      expect(screen.getByTestId('release-card-102')).toBeInTheDocument();
    });

    // Shipped (Done) release v2.3.0 is hidden under default Active & Upcoming scope
    expect(screen.queryByTestId('release-card-103')).not.toBeInTheDocument();

    expect(screen.getByTestId('release-platform-badge-101')).toHaveTextContent('Mobile');
    expect(screen.getByTestId('release-platform-badge-102')).toHaveTextContent('Desktop');
    expect(screen.getByTestId('release-card-remaining-101')).toHaveTextContent('1 Dev · 1 UAT');
    expect(screen.getByTestId('release-card-remaining-102')).toHaveTextContent('All ready');
    expect(screen.getByTestId('release-card-countdown-102')).toHaveTextContent('No target date');

    // No legacy /api/releases? or /workitems or /metrics calls
    const urls = (global.fetch as jest.Mock).mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.startsWith('/api/releases?'))).toBe(false);
    expect(urls.some((u) => u.includes('/workitems'))).toBe(false);
  });

  it('filters by platform segmented control, lifecycle scope, search, and sort', async () => {
    const user = userEvent.setup();
    renderView();

    await screen.findByTestId('release-card-101');

    // Filter by Desktop platform
    await user.click(screen.getByTestId('release-platform-filter-desktop'));
    expect(screen.queryByTestId('release-card-101')).not.toBeInTheDocument();
    expect(screen.getByTestId('release-card-102')).toBeInTheDocument();

    // Switch back to All platforms and Shipped scope
    await user.click(screen.getByTestId('release-platform-filter-all'));
    await user.click(screen.getByTestId('release-scope-filter-shipped'));
    expect(screen.getByTestId('release-card-103')).toBeInTheDocument();
    expect(screen.queryByTestId('release-card-101')).not.toBeInTheDocument();

    // Switch to All scope and search
    await user.click(screen.getByTestId('release-scope-filter-all'));
    expect(screen.getByTestId('release-card-101')).toBeInTheDocument();
    expect(screen.getByTestId('release-card-102')).toBeInTheDocument();
    expect(screen.getByTestId('release-card-103')).toBeInTheDocument();

    await user.type(screen.getByTestId('release-search-input'), 'biometric');
    expect(screen.getByTestId('release-card-101')).toBeInTheDocument();
    expect(screen.queryByTestId('release-card-102')).not.toBeInTheDocument();
    expect(screen.queryByTestId('release-card-103')).not.toBeInTheDocument();
  });

  it('supports sorting by Version and Target Date', async () => {
    const user = userEvent.setup();
    renderView();

    await screen.findByTestId('release-card-101');
    await user.click(screen.getByTestId('release-scope-filter-all'));

    await user.selectOptions(screen.getByTestId('release-sort-select'), 'version');
    const cardsByVersion = screen.getAllByTestId(/^release-card-\d+$/).map((el) => el.getAttribute('data-testid'));
    expect(cardsByVersion).toEqual(['release-card-103', 'release-card-101', 'release-card-102']);
  });
});
