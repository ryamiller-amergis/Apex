/**
 * FEAT-007 PBI-009 / VT-08 — Walkthrough publish notification deep-link E2E.
 *
 * // DEFERRED: Full Playwright execution when e2e stack is unavailable in local session.
 * // Lower-tier: walkthroughNotificationService + notificationService unit tests cover AC-0..3.
 */
import { test, expect, SeedApi, PERSONA_OIDS } from '../support/fixtures';
import { stubAdoProjects, suppressSseStreams } from '../support/api-stubs';
import { NotificationCenterPage } from '../pages/notification-center.page';
import { SidebarPage } from '../pages/sidebar.page';

test.describe('Walkthrough publish notifications (FEAT-007 PBI-009)', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test.beforeEach(async ({ page }) => {
    await suppressSseStreams(page);
  });

  test('AC-0 / VT-08 — walkthrough publish notification shows in bell and deep-links Help', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    await SeedApi.seedNotification(e2eApi, {
      userId: PERSONA_OIDS.developer,
      title: 'New walkthrough available',
      body: 'Intro to Planning',
      type: 'system',
      link: '/?help=walkthroughs',
    });

    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/home');

    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();

    const nc = new NotificationCenterPage(page);
    await nc.clickBell();
    await nc.waitForPanelOpen();

    const item = page.getByTestId('walkthrough-publish-notification');
    await expect(item).toBeVisible({ timeout: 8_000 });
    await expect(item).toContainText('New walkthrough available');
    await expect(item).toContainText('Intro to Planning');

    await item.click();
    await expect(page).toHaveURL(/help=walkthroughs/);
  });
});
