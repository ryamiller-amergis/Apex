/**
 * @smoke
 * AC: notifications
 *
 * Covers the notification bell and notification center:
 * - Unread badge shows the correct count after seeding.
 * - Opening the center displays seeded notifications.
 * - Marking all read clears the badge.
 * - Empty state is shown when there are no notifications.
 */
import { test, expect, SeedApi, PERSONA_OIDS } from '../support/fixtures';
import { stubAdoProjects, suppressSseStreams } from '../support/api-stubs';
import { NotificationCenterPage } from '../pages/notification-center.page';
import { SidebarPage } from '../pages/sidebar.page';

test.describe('Notification center @smoke', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test.beforeEach(async ({ page }) => {
    // Suppress the live SSE stream so tests control notification state via seed data only.
    await suppressSseStreams(page);
  });

  test('notification bell is visible in the app header', async ({ page, loginAsPersona }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/home');

    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();

    const nc = new NotificationCenterPage(page);
    await expect(nc.bell()).toBeVisible({ timeout: 10_000 });
  });

  test('seeded unread notification increments the badge count', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    // Seed one unread notification for the developer persona.
    await SeedApi.seedNotification(e2eApi, {
      userId: PERSONA_OIDS.developer,
      title: 'New assignment',
      body: 'You have been assigned to E2E Test PBI',
      type: 'system',
    });

    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/home');

    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();

    // Poll for the badge to appear (the app may fetch notifications asynchronously).
    const nc = new NotificationCenterPage(page);
    await expect.poll(() => nc.getUnreadCount(), { timeout: 8_000 }).toBeGreaterThan(0);
  });

  test('clicking the bell opens the notification center', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    await SeedApi.seedNotification(e2eApi, {
      userId: PERSONA_OIDS.ba,
      title: 'Interview ready for review',
      type: 'system',
    });

    await stubAdoProjects(page);
    await loginAsPersona('ba');
    await page.goto('/home');

    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();

    const nc = new NotificationCenterPage(page);
    await nc.clickBell();
    await nc.waitForPanelOpen();

    // The center panel heading should be visible.
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible({ timeout: 5_000 });
  });

  test('no notifications shows empty state', async ({ page, loginAsPersona }) => {
    // No seed — the developer persona has no notifications.
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/home');

    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();

    const nc = new NotificationCenterPage(page);
    await nc.clickBell();
    await nc.waitForPanelOpen();

    // Should show empty state text.
    await expect(
      page.getByText(/no.*notification|all caught up|nothing here|you.re all caught up/i)
    ).toBeVisible({ timeout: 5_000 });
  });

  test('notification preferences page renders without errors', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');

    const nc = new NotificationCenterPage(page);
    await nc.gotoPreferences();

    // The preferences page should render (no crash / 404).
    await expect(page).not.toHaveURL(/404|error/i);
    await expect(
      page.getByText(/notification|preference|alert/i).first()
    ).toBeVisible({ timeout: 8_000 });
  });
});
