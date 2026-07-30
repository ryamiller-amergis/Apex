/**
 * FEAT-008 — WalkthroughReportingSection UI states.
 * @jest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WalkthroughReportingSection } from '../WalkthroughReportingSection';

function mockJson(data: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: async () => data,
  } as Response);
}

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WalkthroughReportingSection />
    </QueryClientProvider>,
  );
}

describe('WalkthroughReportingSection (FEAT-008)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('PBI-010 AC-0 — shows X of Y and completed/dismissed detail', async () => {
    global.fetch = jest.fn().mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/platform-admin/walkthroughs?') && url.includes('lifecycle=published')) {
        return mockJson({
          items: [
            {
              id: 'wt-1',
              userTitle: 'Intro',
              revision: 2,
              targeting: { project: 'Apex' },
            },
          ],
          nextCursor: null,
        });
      }
      if (url.includes('/reports/acknowledgement')) {
        return mockJson({
          walkthroughId: 'wt-1',
          revision: 2,
          generatedAt: '2026-07-29T12:00:00.000Z',
          acknowledgedCount: 1,
          audienceCount: 2,
          completedCount: 1,
          dismissedCount: 0,
          details: [
            {
              userId: 'u1',
              displayName: 'Ada',
              email: 'ada@example.com',
              status: 'completed',
              acknowledgedAt: '2026-07-29T11:00:00.000Z',
            },
          ],
          completed: [
            {
              userId: 'u1',
              displayName: 'Ada',
              email: 'ada@example.com',
              status: 'completed',
              acknowledgedAt: '2026-07-29T11:00:00.000Z',
            },
          ],
          dismissed: [],
        });
      }
      if (url.includes('/reports/anchor-misses')) {
        return mockJson({ items: [], nextCursor: null });
      }
      return mockJson({}, false, 404);
    });

    renderSection();

    await waitFor(() => {
      expect(screen.getByTestId('acknowledgement-summary')).toHaveTextContent('1 of 2');
    });
    expect(screen.getByTestId('acknowledgement-detail-table')).toHaveTextContent('Ada');
    expect(screen.getByTestId('acknowledgement-detail-table')).toHaveTextContent('completed');
  });

  it('PBI-010 AC-1 — error state replaces summary (no partial counts)', async () => {
    global.fetch = jest.fn().mockImplementation((input) => {
      const url = String(input);
      if (url.includes('lifecycle=published')) {
        return mockJson({
          items: [{ id: 'wt-1', userTitle: 'Intro', revision: 1, targeting: { project: 'Apex' } }],
          nextCursor: null,
        });
      }
      if (url.includes('/reports/acknowledgement')) {
        return mockJson({ error: 'Report calculation failed' }, false, 500);
      }
      if (url.includes('/reports/anchor-misses')) {
        return mockJson({ items: [], nextCursor: null });
      }
      return mockJson({}, false, 404);
    });

    renderSection();

    await waitFor(() => {
      expect(screen.getByTestId('walkthrough-report-error')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('acknowledgement-summary')).not.toBeInTheDocument();
  });

  it('PBI-011 AC-0 — Missing Anchors tab lists Step-associated events', async () => {
    const user = userEvent.setup();
    global.fetch = jest.fn().mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/platform-admin/walkthroughs') && !url.includes('/reports/')) {
        return mockJson({
          items: [{ id: 'wt-1', userTitle: 'Intro', revision: 1, targeting: { project: 'Apex' } }],
          nextCursor: null,
        });
      }
      if (url.includes('/reports/acknowledgement')) {
        return mockJson({
          walkthroughId: 'wt-1',
          revision: 1,
          generatedAt: '2026-07-29T12:00:00.000Z',
          acknowledgedCount: 0,
          audienceCount: 1,
          completedCount: 0,
          dismissedCount: 0,
          details: [],
          completed: [],
          dismissed: [],
        });
      }
      if (url.includes('/reports/anchor-misses')) {
        return mockJson({
          items: [
            {
              id: 'miss-1',
              walkthroughId: 'wt-1',
              stepId: 'step-1',
              stepOrder: 0,
              stepHeading: 'Open menu',
              revision: 1,
              anchorKey: 'user-menu-trigger',
              targetRoute: '/home',
              occurredAt: '2026-07-29T12:30:00.000Z',
            },
          ],
          nextCursor: null,
        });
      }
      return mockJson({}, false, 404);
    });

    renderSection();
    await waitFor(() =>
      expect(screen.getByTestId('walkthrough-report-tab-anchor-misses')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('walkthrough-report-tab-anchor-misses'));

    await waitFor(() => {
      expect(screen.getByTestId('anchor-miss-table')).toHaveTextContent('Open menu');
      expect(screen.getByTestId('anchor-miss-table')).toHaveTextContent('user-menu-trigger');
    });
  });

  it('empty catalog shows empty state', async () => {
    global.fetch = jest.fn().mockImplementation((input) => {
      const url = String(input);
      if (url.includes('lifecycle=published')) {
        return mockJson({ items: [], nextCursor: null });
      }
      return mockJson({}, false, 404);
    });

    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('walkthrough-report-empty')).toHaveTextContent(
        'No published Walkthroughs available',
      );
    });
  });
});
