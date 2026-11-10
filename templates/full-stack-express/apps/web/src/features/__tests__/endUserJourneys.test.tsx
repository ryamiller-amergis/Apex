// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  analyzeInsights,
  createNotification,
  getNotifications,
  markNotificationsRead,
  type InsightsAnalysis,
  type NotificationItem,
} from '@project-scope/contracts';
import { checkThemeContrast, formatContrastFailure } from '@project-scope/ui';
import viteConfig from '../../../vite.config';
import { homeTestIds } from '../home/HomeDashboardPage';
import { insightsTestIds } from '../insights/InsightsPage';
import { notificationsTestIds } from '../notifications/NotificationsPage';
import { settingsTestIds } from '../settings/SettingsPage';
import { installFetch, jsonResponse } from '../../testing/fetchMock';
import { problemResponse, sampleProfile } from '../../testing/profileFixture';
import { renderApp } from '../../testing/renderApp';
import { resolvedStyle } from '../../../../../packages/ui/src/testing/resolvedStyle';
import { setViewport } from '../../testing/setViewport';
import overrides, { brandConfig } from '../../theme/overrides';

describe('Template End-User E2E & Integration Journeys', () => {
  it('Scenario 1 — Build a Chart & Dashboard: lands on signed-in home dashboard, views tailored domain metrics and interactive DataChartCard, switches timeframe filters, and verifies accessible SVG rendering', async () => {
    setViewport(1280);
    const user = userEvent.setup();
    installFetch(() => jsonResponse(sampleProfile));

    renderApp('/');

    expect(await screen.findByTestId(homeTestIds.page)).toBeInTheDocument();
    expect(screen.getByTestId(homeTestIds.welcomeBanner)).toHaveTextContent(
      /Signed in as Sam Example · Operations Lead/
    );

    // Tailored domain metrics (never "Item 1" or "Todo 1")
    expect(
      screen.getByTestId('metric-card-throughput-value')
    ).toHaveTextContent('724');
    expect(screen.getByTestId('metric-card-sla-value')).toHaveTextContent(
      '98.4%'
    );
    expect(document.body.textContent ?? '').not.toMatch(/\b(Item 1|Todo 1)\b/);

    // Accessible SVG chart with theme tokens
    const svg = screen.getByTestId('data-chart-fulfillment-svg');
    expect(svg).toHaveAttribute('role', 'img');
    expect(svg).toHaveAccessibleName('Fulfillment Throughput chart');
    expect(
      screen.getByTestId('data-chart-fulfillment-bar-mon')
    ).toBeInTheDocument();

    // Switch timeframe filter to 30 days and 90 days
    await user.click(screen.getByTestId('data-chart-fulfillment-filter-30d'));
    expect(
      screen.getByTestId('data-chart-fulfillment-filter-30d')
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByTestId('metric-card-throughput-value')
    ).toHaveTextContent('2,383');
    expect(
      screen.getByTestId('data-chart-fulfillment-bar-wk1')
    ).toBeInTheDocument();

    await user.click(screen.getByTestId('data-chart-fulfillment-filter-90d'));
    expect(
      screen.getByTestId('metric-card-throughput-value')
    ).toHaveTextContent('7,210');
    expect(
      screen.getByTestId('data-chart-fulfillment-bar-jan')
    ).toBeInTheDocument();
  });

  it('Scenario 2 — Notification Module: opens Notifications, sees seeded domain notifications and unread badge count, triggers a new notification, filters by unread, and marks notifications as read with live UI updates', async () => {
    setViewport(1280);
    const user = userEvent.setup();

    let items: NotificationItem[] = [
      {
        id: 'notif-ops-01',
        title: 'Morning fulfillment batch completed',
        message:
          'All 42 priority orders cleared quality review with zero exceptions.',
        category: 'workflow',
        read: false,
        createdAt: '09:00 UTC',
      },
      {
        id: 'notif-sys-03',
        title: 'Connector sync verified',
        message:
          'Logistics Telemetry Feed completed its scheduled 15-minute checkpoint.',
        category: 'system',
        read: true,
        createdAt: '08:00 UTC',
      },
    ];

    installFetch((call) => {
      if (call.url.endsWith(getNotifications.path) && call.method === 'GET') {
        return jsonResponse({
          items,
          unreadCount: items.filter((item) => !item.read).length,
        });
      }
      if (
        call.url.endsWith(createNotification.path) &&
        call.method === 'POST'
      ) {
        const body = call.body as {
          title: string;
          message: string;
          category?: NotificationItem['category'];
        };
        items = [
          {
            id: 'notif-custom-11',
            title: body.title,
            message: body.message,
            category: body.category ?? 'workflow',
            read: false,
            createdAt: '10:00 UTC',
          },
          ...items,
        ];
        return jsonResponse({
          items,
          unreadCount: items.filter((item) => !item.read).length,
        });
      }
      if (
        call.url.endsWith(markNotificationsRead.path) &&
        call.method === 'PUT'
      ) {
        const body = call.body as {
          notificationId?: string;
          markAll?: boolean;
        };
        items = items.map((item) =>
          body.markAll || item.id === body.notificationId
            ? { ...item, read: true }
            : item
        );
        return jsonResponse({
          items,
          unreadCount: items.filter((item) => !item.read).length,
        });
      }
      return jsonResponse(sampleProfile);
    });

    renderApp('/notifications');

    expect(
      await screen.findByTestId('notification-unread-badge')
    ).toHaveTextContent('1 unread');
    expect(
      screen.getByTestId('notification-item-notif-ops-01')
    ).toBeInTheDocument();

    // Trigger a new notification
    await user.type(
      screen.getByTestId(notificationsTestIds.titleInput),
      'Midwest dock alert cleared'
    );
    await user.type(
      screen.getByTestId(notificationsTestIds.messageInput),
      'Carrier lane ORD-2 resumed normal dispatch cadence.'
    );
    await user.click(screen.getByTestId(notificationsTestIds.triggerButton));

    await waitFor(() => {
      expect(screen.getByTestId('notification-unread-badge')).toHaveTextContent(
        '2 unread'
      );
    });
    expect(
      screen.getByTestId('notification-item-notif-custom-11')
    ).toHaveTextContent('Midwest dock alert cleared');

    // Filter by unread
    await user.click(screen.getByTestId('notification-filter-unread'));
    expect(
      screen.queryByTestId('notification-item-notif-sys-03')
    ).not.toBeInTheDocument();

    // Mark one notification as read
    await user.click(
      screen.getByTestId('notification-mark-read-notif-custom-11')
    );
    await waitFor(() => {
      expect(screen.getByTestId('notification-unread-badge')).toHaveTextContent(
        '1 unread'
      );
    });

    // Mark all read
    await user.click(screen.getByTestId('notification-mark-all-read'));
    await waitFor(() => {
      expect(screen.getByTestId('notification-unread-badge')).toHaveTextContent(
        '0 unread'
      );
    });
  });

  it('Scenario 3 — AI Skill Grounded in Database + Third-Party Feed: invokes composer-2.5 skill adapter, displays grounded findings with citations and recommended actions, and handles error retry', async () => {
    setViewport(1280);
    const user = userEvent.setup();
    let failFirst = true;

    const sampleAnalysis: InsightsAnalysis = {
      skillName: 'operational-briefing',
      modelId: 'composer-2.5',
      focusArea: 'operations',
      headline:
        'Fulfillment throughput rose 14% while connector telemetry flagged two regional carrier delays.',
      findings: [
        {
          id: 'finding-carrier-delay',
          title: 'Rebalance Midwest carrier dispatch window',
          summary:
            'Database order cycle logs and carrier webhook telemetry show a 35-minute pickup lag on afternoon routes.',
          impact: 'high',
          recommendedAction:
            'Shift priority Midwest dispatches to the 13:30 cutoff and notify warehouse leads.',
          citationIds: ['cit-db-orders', 'cit-conn-carrier'],
        },
      ],
      citations: [
        {
          id: 'cit-db-orders',
          sourceKind: 'database',
          sourceLabel:
            'Database · Fulfillment Ledger (3 active profile records)',
          excerpt:
            '42 priority batches completed with 98.4% on-time verification across primary hubs.',
        },
        {
          id: 'cit-conn-carrier',
          sourceKind: 'connector',
          sourceLabel: 'Connector · Logistics Telemetry Feed',
          excerpt:
            'Regional hub ORD-2 reported a 35-minute dock queue spike between 14:00 and 16:00.',
        },
      ],
    };

    installFetch((call) => {
      if (call.url.endsWith(analyzeInsights.path)) {
        if (failFirst) {
          failFirst = false;
          return problemResponse(503);
        }
        const body = (call.body ?? {}) as {
          focusArea?: 'operations' | 'retention' | 'capacity';
        };
        return jsonResponse({
          ...sampleAnalysis,
          focusArea: body.focusArea ?? 'operations',
        });
      }
      return jsonResponse(sampleProfile);
    });

    renderApp('/insights');

    // Error state first, then retry
    expect(
      await screen.findByTestId(insightsTestIds.error)
    ).toBeInTheDocument();
    await user.click(screen.getByTestId(insightsTestIds.retry));

    // Loaded state with composer-2.5 model badge, findings, recommended action, and citations
    expect(
      await screen.findByTestId(insightsTestIds.headline)
    ).toHaveTextContent(sampleAnalysis.headline);
    expect(screen.getByTestId(insightsTestIds.modelBadge)).toHaveTextContent(
      'Model: composer-2.5'
    );
    expect(
      screen.getByTestId('insights-action-finding-carrier-delay')
    ).toHaveTextContent(
      'Shift priority Midwest dispatches to the 13:30 cutoff and notify warehouse leads.'
    );
    const citations = screen.getByTestId(insightsTestIds.citationsList);
    expect(
      within(citations).getByTestId('insights-citation-cit-db-orders')
    ).toHaveTextContent('Database · Fulfillment Ledger');
    expect(
      within(citations).getByTestId('insights-citation-cit-conn-carrier')
    ).toHaveTextContent('Connector · Logistics Telemetry Feed');
  });

  it('Scenario 4 — Revision Updates (Copy, Brand Theme, and Centered Layout): verifies centered AppShell geometry (maxWidth 960, alignSelf center), brand overrides contrast, and Vite @project-scope/ui source alias', async () => {
    setViewport(1280);
    installFetch(() => jsonResponse(sampleProfile));

    renderApp('/settings');

    expect(await screen.findByTestId(settingsTestIds.page)).toBeInTheDocument();
    expect(screen.getByTestId(settingsTestIds.brandName)).toHaveTextContent(
      brandConfig.appName
    );
    expect(screen.getByTestId(settingsTestIds.brandTagline)).toHaveTextContent(
      brandConfig.tagline
    );

    // Verify AppShell main container is centered with maxWidth 960px and alignSelf center
    const main = screen.getByTestId('app-shell-main');
    expect(resolvedStyle(main, 'max-width')).toBe('960px');
    expect(resolvedStyle(main, 'align-self')).toBe('center');

    // Verify brand overrides pass WCAG 2.1 AA contrast in both light and dark modes
    expect(checkThemeContrast(overrides).map(formatContrastFailure)).toEqual(
      []
    );

    // Verify Vite config aliases @project-scope/ui to packages/ui/src/index.ts in serve/dev mode
    const resolvedVite =
      typeof viteConfig === 'function'
        ? await viteConfig({ command: 'serve', mode: 'development' })
        : viteConfig;
    const alias = resolvedVite.resolve?.alias as
      Record<string, string> | undefined;
    expect(alias?.['@project-scope/ui']).toMatch(
      /packages[\\/]ui[\\/]src[\\/]index\.ts$/
    );
  });
});
