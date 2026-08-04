/**
 * FEAT-006 / PBI-009 — Cross-device What's New State e2e
 *
 * Authored against design-spec data-testid contracts (VT-14, VT-15, TC-PBI-009-001/005/006).
 * // DEFERRED: Playwright env execution deferred in local Feature Executor runs
 * unless browsers are installed; specs remain syntactically valid.
 * Lower-tier substitutes: useWhatsNewState.test.ts, WhatsNewSurfaces.test.tsx,
 * whatsNewStateService.test.ts.
 */
import { test, expect } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';

test.describe('Cross-Device What\'s New State @profile @feat-006', () => {
  // DEFERRED: Playwright env unavailable
  test.skip('TC-PBI-009-001 / AC-0 / VT-14: badge, menu marker, and banner share unread state', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await page.route('**/api/me/permissions**', async (route) => {
      const json = {
        permissions: ['home:view'],
        roles: ['member'],
        groups: [],
        userId: 'user-e2e',
        isSuperAdmin: false,
        changelogUnread: true,
        currentChangelogVersion: '2.0.1',
        lastSeenChangelogVersion: '1.9.0',
        showChangelogOnLogin: true,
        betaAnnouncementDismissed: true,
        whatsNew: {
          status: 'ready',
          currentVersion: '2.0.1',
          lastSeenVersion: '1.9.0',
          unread: true,
          showOnLogin: true,
          seeded: false,
        },
      };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) });
    });
    await page.route('**/api/changelog', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          currentVersion: '2.0.1',
          entries: [
            { version: '2.0.1', date: '2026-07-01', title: 'Latest', changes: [] },
            { version: '1.9.0', date: '2026-06-01', title: 'Prior', changes: [] },
          ],
        }),
      });
    });

    await loginAsPersona('developer');
    await page.goto('/');

    await expect(page.getByTestId('whats-new-banner')).toBeVisible();
    await expect(page.getByTestId('whats-new-avatar-indicator')).toBeVisible();

    await page.getByTestId('user-menu-trigger').click();
    await expect(page.getByTestId('whats-new-menu-indicator')).toBeVisible();
  });

  // DEFERRED: Playwright env unavailable
  test.skip('TC-PBI-009-005 / AC-4 / VT-14: dismiss on session A clears proactive UI on session B', async ({
    browser,
    loginAsPersona,
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    let lastSeen = '1.9.0';
    const fulfillPermissions = async (route: Parameters<typeof pageA.route>[1] extends infer _T ? any : never) => {
      const unread = lastSeen !== '2.0.1';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          permissions: ['home:view'],
          roles: ['member'],
          groups: [],
          userId: 'user-e2e',
          isSuperAdmin: false,
          changelogUnread: unread,
          currentChangelogVersion: '2.0.1',
          lastSeenChangelogVersion: lastSeen,
          showChangelogOnLogin: true,
          betaAnnouncementDismissed: true,
          whatsNew: {
            status: unread ? 'ready' : 'seeded',
            currentVersion: '2.0.1',
            lastSeenVersion: lastSeen,
            unread,
            showOnLogin: true,
            seeded: !unread,
          },
        }),
      });
    };

    for (const page of [pageA, pageB]) {
      await stubAdoProjects(page);
      await page.route('**/api/me/permissions**', fulfillPermissions);
      await page.route('**/api/changelog', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            currentVersion: '2.0.1',
            entries: [{ version: '2.0.1', date: '2026-07-01', title: 'Latest', changes: [] }],
          }),
        });
      });
      await page.route('**/api/me/preferences', async (route) => {
        const body = route.request().postDataJSON() as { lastSeenVersion?: string };
        if (body.lastSeenVersion) lastSeen = body.lastSeenVersion;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            whatsNew: {
              status: 'seeded',
              currentVersion: '2.0.1',
              lastSeenVersion: '2.0.1',
              unread: false,
              showOnLogin: true,
              seeded: true,
            },
          }),
        });
      });
    }

    await loginAsPersona('developer');
    await pageA.goto('/');
    await expect(pageA.getByTestId('whats-new-banner')).toBeVisible();
    await pageA.getByTestId('whats-new-banner-dismiss').click();
    await expect(pageA.getByTestId('whats-new-banner')).toHaveCount(0);

    await pageB.goto('/');
    await expect(pageB.getByTestId('whats-new-banner')).toHaveCount(0);
    await expect(pageB.getByTestId('whats-new-avatar-indicator')).toHaveCount(0);

    await contextA.close();
    await contextB.close();
  });

  // DEFERRED: Playwright env unavailable
  test.skip('TC-PBI-009-006 / AC-5 / VT-15: keyboard focus trap and Escape restore', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await page.route('**/api/me/permissions**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          permissions: ['home:view'],
          roles: ['member'],
          groups: [],
          userId: 'user-e2e',
          isSuperAdmin: false,
          changelogUnread: true,
          currentChangelogVersion: '2.0.1',
          lastSeenChangelogVersion: '1.9.0',
          showChangelogOnLogin: false,
          betaAnnouncementDismissed: true,
          whatsNew: {
            status: 'ready',
            currentVersion: '2.0.1',
            lastSeenVersion: '1.9.0',
            unread: true,
            showOnLogin: false,
            seeded: false,
          },
        }),
      });
    });
    await page.route('**/api/changelog', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          currentVersion: '2.0.1',
          entries: [
            { version: '2.0.1', date: '2026-07-01', title: 'Latest', changes: [] },
            { version: '1.9.0', date: '2026-06-01', title: 'Prior', changes: [] },
          ],
        }),
      });
    });

    await loginAsPersona('developer');
    await page.goto('/home');

    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('user-menu-whats-new').click();
    const modal = page.getByTestId('whats-new-modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('whats-new-unseen-divider')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId('user-menu-trigger')).toBeFocused();
  });
});
