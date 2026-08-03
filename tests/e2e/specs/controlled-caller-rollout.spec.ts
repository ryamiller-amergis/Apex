/**
 * PBI-006 — controlled grounding rollout by caller cohort.
 *
 * Platform Admin browser execution requires a Super Admin Playwright persona.
 */
import { test, expect } from '../support/fixtures';

test.describe('PBI-006 controlled caller rollout', () => {
  test.skip('AC-0 / BR-009 / accessibility NFR adds dimensions and reverses with kill switch', async ({
    page,
  }) => {
    // DEFERRED: Playwright env unavailable
    const rulePayloads: Array<Record<string, unknown>> = [];
    const togglePayloads: Array<Record<string, unknown>> = [];
    const flag = {
      id: 'grounding-flag',
      key: 'repo-grounding-workspace-profile',
      description: 'Controlled local grounding rollout',
      enabled: true,
      lifecycle: 'active',
      cleanupReady: false,
      createdBy: 'platform-admin',
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
      rules: [],
    };

    await page.route('**/api/platform-admin/**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;

      if (pathname === '/api/platform-admin/feature-flags' && request.method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([flag]) });
        return;
      }
      if (pathname.endsWith('/feature-flags/grounding-flag/rules') && request.method() === 'POST') {
        const payload = request.postDataJSON() as Record<string, unknown>;
        rulePayloads.push(payload);
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: `rule-${rulePayloads.length}`,
            flagId: flag.id,
            ...payload,
            createdBy: 'platform-admin',
            createdAt: '2026-08-02T00:00:00.000Z',
          }),
        });
        return;
      }
      if (pathname.endsWith('/feature-flags/grounding-flag') && request.method() === 'PATCH') {
        const payload = request.postDataJSON() as Record<string, unknown>;
        togglePayloads.push(payload);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...flag, ...payload }),
        });
        return;
      }

      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/platform-admin');
    await page.getByRole('tab', { name: /feature flags/i }).click();
    const groundingCard = page.locator('article').filter({
      hasText: 'repo-grounding-workspace-profile',
    });
    await groundingCard.getByRole('button', { name: /rules \(0\)/i }).click();

    const targetType = groundingCard.getByLabel('Target type');
    await expect(targetType).toBeVisible();
    await expect(groundingCard.getByTestId('feature-flag-rule-type-caller')).toHaveAttribute(
      'value',
      'caller',
    );
    await expect(groundingCard.getByTestId('feature-flag-rule-type-environment')).toHaveAttribute(
      'value',
      'environment',
    );

    await targetType.selectOption('caller');
    const callerInput = groundingCard.getByLabel('Caller key');
    await callerInput.fill('interview');
    await groundingCard.getByRole('button', { name: /add rule/i }).press('Enter');
    await expect.poll(() => rulePayloads).toContainEqual({
      type: 'caller',
      value: 'interview',
    });

    await targetType.selectOption('environment');
    const environmentInput = groundingCard.getByLabel('Environment name');
    await environmentInput.fill('dev');
    await groundingCard.getByRole('button', { name: /add rule/i }).press('Enter');
    await expect.poll(() => rulePayloads).toContainEqual({
      type: 'environment',
      value: 'dev',
    });

    const killSwitch = groundingCard.getByRole('checkbox', {
      name: 'repo-grounding-workspace-profile kill switch',
    });
    await killSwitch.press('Space');
    await expect.poll(() => togglePayloads).toContainEqual({ enabled: false });
  });
});
