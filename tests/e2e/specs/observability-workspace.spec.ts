/**
 * Platform Admin — Skill-Driven Product Owner Observability E2E Spec.
 *
 * Validates:
 * 1. Twice-daily scheduled digest status (6:00 AM & 6:00 PM) + skill provenance.
 * 2. All 6 core Product Owner signals:
 *    - Top users
 *    - Most common exceptions
 *    - Retention dropped per module
 *    - AI summary of why there could be drops
 *    - Top modules
 *    - AI summary of how we can drive adoption
 * 3. Multi-window trend selector across Today, Last day, Last 7 days,
 *    Last 14 days, Last 30 days, and Last 60 days.
 * 4. Explicit selection of Composer 2.5 (composer-2.5) and Effort Level,
 *    on-demand digest generation, and verification of rendered Composer 2.5 summary.
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../support/fixtures';
import { stubAdoProjects, suppressSseStreams } from '../support/api-stubs';
import {
  buildFallbackPoDigestResponse,
  isObservabilityTrendWindow,
  normalizeObservabilityEffort,
  normalizeObservabilityModel,
} from '../../../src/shared/utils/observabilityPoDigest';
import type { ObservabilityTrendWindow } from '../../../src/shared/types/observability';

test.use({
  viewport: { width: 1440, height: 900 },
  video: { mode: 'on', size: { width: 1440, height: 900 } },
});

async function stubSuperAdminObservabilityEnv(
  page: Page,
  capturedGenerateRequests: Array<Record<string, unknown>>,
): Promise<void> {
  await suppressSseStreams(page);
  await stubAdoProjects(page, [{ id: 'apex', name: 'Apex' }]);

  await page.addInitScript(() => {
    window.localStorage.setItem('selectedProject', 'Apex');
    window.localStorage.setItem('selectedAreaPath', 'Apex');
  });

  await page.route('**/api/me/permissions*', async (route) => {
    const response = await route.fetch();
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...data,
        isSuperAdmin: true,
        betaAnnouncementDismissed: true,
        changelogUnread: false,
        showChangelogOnLogin: false,
        whatsNew: {
          status: 'seeded',
          currentVersion: '1.12.0',
          lastSeenVersion: '1.12.0',
          unread: false,
          showOnLogin: false,
          seeded: true,
        },
      }),
    });
  });

  await page.route('**/api/feature-flags/evaluate*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        flags: {
          'observability-viewer': true,
          'beta-to-prod-announcement': false,
        },
      }),
    });
  });

  await page.route('**/api/available-models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: [
          { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
          { id: 'composer-2.5', displayName: 'Composer 2.5' },
          { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
          { id: 'gpt-5.4', displayName: 'GPT-5.4' },
        ],
      }),
    });
  });

  let persistedModel = 'claude-sonnet-4-6';
  let persistedEffort: 'low' | 'medium' | 'high' = 'medium';
  let persistedSlot: 'morning_6am' | 'evening_6pm' | 'on_demand' = 'morning_6am';

  await page.route('**/api/platform-admin/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const { pathname, searchParams } = url;

    if (pathname === '/api/platform-admin/projects') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          projects: [{ id: 'apex', name: 'Apex', description: 'Apex Platform' }],
        }),
      });
      return;
    }

    if (pathname === '/api/platform-admin/assignments') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ assignments: [] }),
      });
      return;
    }

    if (pathname === '/api/platform-admin/menu-settings') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ configs: [] }),
      });
      return;
    }

    if (pathname === '/api/platform-admin/users') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          users: [
            {
              userId: '11111111-1111-4111-8111-111111111111',
              displayName: 'Ada Lovelace',
              email: 'ada@example.com',
            },
          ],
        }),
      });
      return;
    }

    if (pathname === '/api/platform-admin/groups') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ groups: [] }),
      });
      return;
    }

    if (pathname === '/api/platform-admin/access-requests') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ requests: [] }),
      });
      return;
    }

    if (pathname === '/api/platform-admin/observability/po-digest' && req.method() === 'GET') {
      const project = searchParams.get('project') ?? 'Apex';
      const rawWindow = searchParams.get('window') ?? '7d';
      const window: ObservabilityTrendWindow = isObservabilityTrendWindow(rawWindow)
        ? rawWindow
        : '7d';
      const model = normalizeObservabilityModel(searchParams.get('model') ?? persistedModel);
      const effort = normalizeObservabilityEffort(searchParams.get('effort') ?? persistedEffort);
      const payload = buildFallbackPoDigestResponse({
        project,
        window,
        model,
        effort,
        slot: persistedSlot,
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
      return;
    }

    if (
      pathname === '/api/platform-admin/observability/po-digest/generate' &&
      req.method() === 'POST'
    ) {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      capturedGenerateRequests.push(body);
      const project = typeof body.project === 'string' ? body.project : 'Apex';
      const window: ObservabilityTrendWindow = isObservabilityTrendWindow(body.window)
        ? body.window
        : '7d';
      persistedModel = normalizeObservabilityModel(
        typeof body.model === 'string' ? body.model : persistedModel,
      );
      persistedEffort = normalizeObservabilityEffort(body.effort ?? persistedEffort);
      persistedSlot = 'on_demand';
      const payload = buildFallbackPoDigestResponse({
        project,
        window,
        model: persistedModel,
        effort: persistedEffort,
        slot: persistedSlot,
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });
}

test.describe('Platform Admin — Product Owner Observability Digest', () => {
  test('validates 6 PO signals, multi-window trends, 6 AM & 6 PM schedule, and Composer 2.5 model selection', async ({
    page,
    loginAsPersona,
  }) => {
    const capturedGenerateRequests: Array<Record<string, unknown>> = [];
    await stubSuperAdminObservabilityEnv(page, capturedGenerateRequests);

    await loginAsPersona('product-owner');
    await page.goto('/platform-admin');

    const observabilityTab = page.getByTestId('platform-admin-tab-observability');
    await expect(observabilityTab).toBeVisible();
    await observabilityTab.click();

    const workspace = page.getByTestId('observability-workspace');
    await expect(workspace).toBeVisible();

    // 1. Verify 6:00 AM and 6:00 PM twice-daily scheduled summary display
    await expect(page.getByTestId('observability-schedule-status-badge')).toContainText(
      '6:00 AM & 6:00 PM Daily Digest Active',
    );
    await expect(page.getByTestId('observability-schedule-6am')).toContainText('6:00 AM Daily');
    await expect(page.getByTestId('observability-schedule-6pm')).toContainText('6:00 PM Daily');
    await expect(page.getByTestId('observability-schedule-history')).toContainText(
      '.cursor/skills/observability-po-digest/SKILL.md',
    );

    // 2. Verify all 6 core Product Owner observability sections are visible
    const topUsersCard = page.getByTestId('observability-signal-top-users');
    const exceptionsCard = page.getByTestId('observability-signal-common-exceptions');
    const retentionDropsCard = page.getByTestId('observability-signal-retention-drops');
    const dropReasonsCard = page.getByTestId('observability-signal-drop-reasons');
    const topModulesCard = page.getByTestId('observability-signal-top-modules');
    const driveAdoptionCard = page.getByTestId('observability-signal-drive-adoption');

    await expect(topUsersCard).toContainText('Top users');
    await expect(exceptionsCard).toContainText('Most common exceptions');
    await expect(retentionDropsCard).toContainText('Retention dropped per module');
    await expect(dropReasonsCard).toContainText('AI summary of why there could be drops');
    await expect(topModulesCard).toContainText('Top modules');
    await expect(driveAdoptionCard).toContainText('AI summary of how we can drive adoption');

    // 3. Verify all 6 requested trend windows update the digest view
    const trendWindows: Array<{ key: ObservabilityTrendWindow; label: string }> = [
      { key: 'today', label: 'Today' },
      { key: '1d', label: 'Last day' },
      { key: '7d', label: 'Last 7 days' },
      { key: '14d', label: 'Last 14 days' },
      { key: '30d', label: 'Last 30 days' },
      { key: '60d', label: 'Last 60 days' },
    ];

    for (const w of trendWindows) {
      const btn = page.getByTestId(`observability-window-${w.key}`);
      await expect(btn).toHaveText(w.label);
      await btn.click();
      await expect(btn).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('observability-active-model-badge')).toContainText(w.label);
      await page.waitForTimeout(200);
    }

    // 4. CRITICAL: Explicitly select Composer 2.5 (composer-2.5) and Effort Level, then generate digest
    const modelSelect = page.getByTestId('observability-model-select');
    const effortSelect = page.getByTestId('observability-effort-select');

    // Switch to another model first so selecting Composer 2.5 demonstrates an explicit model change
    await modelSelect.selectOption('claude-sonnet-4-6');
    await expect(modelSelect).toHaveValue('claude-sonnet-4-6');

    // Explicitly select Composer 2.5 (composer-2.5) and High thinking effort
    await modelSelect.selectOption({ label: 'Composer 2.5' });
    await expect(modelSelect).toHaveValue('composer-2.5');

    await effortSelect.selectOption('high');
    await expect(effortSelect).toHaveValue('high');

    // Select Last 30 days window and trigger on-demand skill digest generation
    await page.getByTestId('observability-window-30d').click();
    await page.getByTestId('observability-generate-digest').click();

    await expect.poll(() => capturedGenerateRequests.length).toBe(1);
    expect(capturedGenerateRequests[0]).toMatchObject({
      project: 'Apex',
      window: '30d',
      model: 'composer-2.5',
      effort: 'high',
      slot: 'on_demand',
    });

    // Verify rendered summary reflects Composer 2.5 and High effort across headline, provenance, and AI cards
    await expect(page.getByTestId('observability-active-model-badge')).toContainText(
      'Composer 2.5 (composer-2.5) · High · Last 30 days',
    );
    await expect(page.getByTestId('observability-digest-headline')).toContainText(
      'On-Demand Digest (Last 30 days)',
    );
    await expect(page.getByTestId('observability-digest-headline')).toContainText('composer-2.5');
    await expect(dropReasonsCard).toContainText('Composer 2.5 (High effort)');
    await expect(driveAdoptionCard).toContainText('Composer 2.5 (High effort)');

    // Scroll smoothly through the 6 visual sections so the recorded E2E video captures the entire layout
    await topUsersCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(450);
    await retentionDropsCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(450);
    await topModulesCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(450);
    await workspace.scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);

    if (process.env.E2E_SCREENSHOT_PATH) {
      await page.screenshot({
        path: process.env.E2E_SCREENSHOT_PATH,
        fullPage: true,
      });
    }
  });
});
