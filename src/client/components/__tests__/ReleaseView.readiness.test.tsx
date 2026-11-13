import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReleaseView from '../ReleaseView';
import type { WorkItem } from '../../types/workitem';

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    isInAnyGroup: () => true,
    permissionsLoaded: true,
    can: () => true,
  }),
}));

const EPIC = {
  id: 201,
  version: 'v2.4.0',
  status: 'In Progress',
  areaPath: 'MaxView\\Mobile',
  platform: 'Mobile',
  startDate: '2026-11-01',
  targetDate: undefined,
  description: 'Mobile biometric login',
  progress: 25,
  totalItems: 4,
  completedItems: 1,
  greenItems: 1,
  amberItems: 1,
  redItems: 2,
};

const RELATED_ITEMS: WorkItem[] = [
  {
    id: 501,
    title: 'FaceID Integration',
    state: 'In Progress',
    workItemType: 'Feature',
    assignedTo: 'Alice',
    areaPath: 'MaxView\\Mobile',
    iterationPath: 'Sprint 1',
    changedDate: '2026-11-02',
    createdDate: '2026-10-25',
  },
  {
    id: 502,
    title: 'TouchID Fallback',
    state: 'Blocked',
    workItemType: 'Bug',
    assignedTo: undefined,
    areaPath: 'MaxView\\Mobile',
    iterationPath: 'Sprint 1',
    changedDate: '2026-11-03',
    createdDate: '2026-10-26',
  },
  {
    id: 503,
    title: 'Biometric Settings Toggle',
    state: 'UAT - Ready For Test',
    workItemType: 'Product Backlog Item',
    assignedTo: 'Bob',
    areaPath: 'MaxView\\Mobile',
    iterationPath: 'Sprint 1',
    changedDate: '2026-11-04',
    createdDate: '2026-10-27',
  },
  {
    id: 504,
    title: 'Keychain Wrapper',
    state: 'Done',
    workItemType: 'Technical Backlog Item',
    assignedTo: 'Carol',
    areaPath: 'MaxView\\Mobile',
    iterationPath: 'Sprint 1',
    changedDate: '2026-11-05',
    createdDate: '2026-10-28',
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

describe('ReleaseView - Readiness Summary & Scoped Work-Item Tabs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/releases/epics')) {
        return Promise.resolve({ ok: true, json: async () => [EPIC] });
      }
      if (url.includes('/api/releases/201/related-items')) {
        return Promise.resolve({ ok: true, json: async () => RELATED_ITEMS });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    }) as jest.Mock;
  });

  it('renders What Else Is Needed readiness counters, gap pills, and filters work items when clicked', async () => {
    const user = userEvent.setup();
    renderView();

    await waitFor(() => {
      expect(screen.getByTestId('readiness-summary')).toBeInTheDocument();
      expect(screen.getByTestId('release-item-201-501')).toBeInTheDocument();
    });

    // Breakdown counters
    expect(screen.getByTestId('readiness-count-ready')).toHaveTextContent('1');
    expect(screen.getByTestId('readiness-count-uat')).toHaveTextContent('1');
    expect(screen.getByTestId('readiness-count-not-ready')).toHaveTextContent('2');

    // Default tab is Needs Attention (502 Blocked, 501 In Progress, 503 UAT; 504 Done excluded)
    expect(screen.getByTestId('release-item-201-502')).toBeInTheDocument();
    expect(screen.getByTestId('release-item-201-501')).toBeInTheDocument();
    expect(screen.getByTestId('release-item-201-503')).toBeInTheDocument();
    expect(screen.queryByTestId('release-item-201-504')).not.toBeInTheDocument();

    // Gap pills present
    expect(screen.getByTestId('gap-pill-dev')).toHaveTextContent('2 items still in Dev');
    expect(screen.getByTestId('gap-pill-uat')).toHaveTextContent('1 awaiting UAT');
    expect(screen.getByTestId('gap-pill-unassigned')).toHaveTextContent('1 unassigned');
    expect(screen.getByTestId('gap-pill-no-target-date')).toHaveTextContent('No target date');
    expect(screen.getByTestId('gap-pill-no-outcome')).toHaveTextContent('No deployment outcome recorded');

    // Click unassigned gap pill -> only #502 shown
    await user.click(screen.getByTestId('gap-pill-unassigned'));
    expect(screen.getByTestId('release-item-201-502')).toBeInTheDocument();
    expect(screen.queryByTestId('release-item-201-501')).not.toBeInTheDocument();
    expect(screen.queryByTestId('release-item-201-503')).not.toBeInTheDocument();

    // Click again or reset -> restored
    await user.click(screen.getByTestId('gap-filter-reset'));
    expect(screen.getByTestId('release-item-201-501')).toBeInTheDocument();
    expect(screen.getByTestId('release-item-201-503')).toBeInTheDocument();

    // Switch to Ready / Done tab
    await user.click(screen.getByTestId('release-tab-ready'));
    expect(screen.getByTestId('release-item-201-504')).toBeInTheDocument();
    expect(screen.queryByTestId('release-item-201-501')).not.toBeInTheDocument();

    // Switch to All Items tab
    await user.click(screen.getByTestId('release-tab-all'));
    expect(screen.getByTestId('release-item-201-501')).toBeInTheDocument();
    expect(screen.getByTestId('release-item-201-502')).toBeInTheDocument();
    expect(screen.getByTestId('release-item-201-503')).toBeInTheDocument();
    expect(screen.getByTestId('release-item-201-504')).toBeInTheDocument();
  });
});
