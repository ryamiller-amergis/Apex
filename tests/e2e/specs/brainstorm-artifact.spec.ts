/**
 * FEAT-003 — living artifact, versions and handoffs (VT-47, VT-48).
 *
 * The collaborator's drafts are seeded through `/seed/brainstorm-artifact`, which writes
 * versions through the real store, so these specs do not need a model or a V2 worker.
 * Creating the ADR also needs a project repository; when the action reports one is
 * missing, that step is skipped and the version steps still run.
 */
import type { Page } from '@playwright/test';
import { expect, test, E2E_PROJECT, SeedApi } from '../support/fixtures';
import { devLogin } from '../support/auth';
import { stubAdoProjects } from '../support/api-stubs';
import { DEFAULT_ENABLED_MENU_VIEWS } from '../../../src/shared/types/menuSettings';

const OTHER_PROJECT = 'MatterWorx';

const DRAFT = `# [E2E] Use OIDC for sign-in

## Context

Session cookies do not work for cross-origin clients.`;

const FULL_ADR = `${DRAFT}

## Considered Options

- OIDC with PKCE
- Keep session cookies

## Decision Outcome

Chosen option: OIDC with PKCE.

## Consequences

Clients must handle token refresh.`;

async function selectProject(page: Page, project: string): Promise<void> {
  await page.addInitScript((p) => {
    window.localStorage.setItem('selectedProject', p);
    window.localStorage.setItem('selectedAreaPath', p);
  }, project);
}

function api(path: string, project: string): string {
  return `/api/brainstorm/sessions${path}?project=${encodeURIComponent(project)}`;
}

async function createSession(page: Page): Promise<string> {
  const created = await page.request.post(api('', E2E_PROJECT), { data: {} });
  test.skip(created.status() === 409, 'V2 interactive transport is not running in this environment');
  expect(created.status()).toBe(201);
  const { session } = (await created.json()) as { session: { id: string } };
  return session.id;
}

test.describe('Brainstorm artifact @feat-003', () => {
  test.beforeEach(async ({ page, request }) => {
    await SeedApi.setMenuSettings(request, E2E_PROJECT, [...DEFAULT_ENABLED_MENU_VIEWS]);
    await SeedApi.setMenuSettings(request, OTHER_PROJECT, [...DEFAULT_ENABLED_MENU_VIEWS]);
    await SeedApi.setBrainstormFlag(request, { enabled: true, projects: [E2E_PROJECT] });
    await stubAdoProjects(page);
  });

  test.afterAll(async ({ request }) => {
    await SeedApi.setBrainstormFlag(request, { enabled: false, projects: [] });
  });

  test('VT-47 PBI-011 (a), PBI-013 (a), PBI-017 (a): checkpoint, compare, roll back and create a Proposed ADR', async ({ page, request, loginAsPersona }) => {
    await selectProject(page, E2E_PROJECT);
    await loginAsPersona('developer');
    await page.goto('/home');
    const sessionId = await createSession(page);
    await SeedApi.seedBrainstormArtifact(request, { sessionId, type: 'adr', versions: [DRAFT, FULL_ADR] });

    await page.goto(`/brainstorm/${sessionId}`);
    const panel = page.getByTestId('brainstorm-artifact-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('brainstorm-artifact-body')).toContainText('Decision Outcome');
    await expect(panel).toContainText('Version 3');

    await page.getByTestId('brainstorm-checkpoint-input').fill('Full draft');
    await page.getByTestId('brainstorm-checkpoint-save').click();
    await expect(page.getByTestId('brainstorm-checkpoint-input')).toHaveValue('');

    await page.getByTestId('brainstorm-history-open').click();
    const drawer = page.getByTestId('brainstorm-history-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('brainstorm-version-row-3')).toContainText('Full draft');
    await page.getByTestId('brainstorm-version-select-2').check();
    await page.getByTestId('brainstorm-version-select-3').check();
    await page.getByTestId('brainstorm-version-compare').click();
    await expect(page.getByTestId('brainstorm-compare-view')).toContainText('Decision Outcome');

    await page.getByTestId('brainstorm-rollback-2').click();
    await expect(page.getByTestId('brainstorm-version-row-4')).toContainText('Rollback');
    await page.getByTestId('brainstorm-history-close').click();
    await expect(page.getByTestId('brainstorm-artifact-body')).not.toContainText('Decision Outcome');

    // Restore the full ADR (version 3) so it can be handed off.
    await page.getByTestId('brainstorm-history-open').click();
    await page.getByTestId('brainstorm-rollback-3').click();
    await expect(page.getByTestId('brainstorm-version-row-5')).toBeVisible();
    await page.getByTestId('brainstorm-history-close').click();
    await expect(page.getByTestId('brainstorm-artifact-body')).toContainText('Decision Outcome');

    const adrAction = page.getByTestId('brainstorm-action-create-adr');
    await expect(adrAction).toBeVisible();
    const reason = page.getByTestId('brainstorm-action-reason-create-adr');
    if (await reason.count()) {
      test.skip(/repository/i.test((await reason.textContent()) ?? ''), 'The e2e project has no repository configured');
    }
    await page.getByTestId('brainstorm-action-start-create-adr').click();
    const modal = page.getByTestId('brainstorm-handoff-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Proposed');
    await page.getByTestId('brainstorm-handoff-confirm').click();
    const link = page.getByTestId('brainstorm-handoff-result-link');
    await expect(link).toBeVisible({ timeout: 30_000 });
    await link.click();
    await expect(page).toHaveURL(/\/adr\/[0-9a-f-]{36}/);
  });

  test('VT-48 PBI-013 (d), PBI-014 (d), PBI-015 (d): another member reads only; another project gets not found', async ({ page, browser, request, loginAsPersona }) => {
    await selectProject(page, E2E_PROJECT);
    await loginAsPersona('developer');
    await page.goto('/home');
    const sessionId = await createSession(page);
    await SeedApi.seedBrainstormArtifact(request, { sessionId, type: 'adr', versions: [DRAFT, FULL_ADR] });

    const memberContext = await browser.newContext();
    const member = await memberContext.newPage();
    try {
      await stubAdoProjects(member);
      await selectProject(member, E2E_PROJECT);
      await devLogin(member, 'ba');
      await member.goto(`/brainstorm/${sessionId}`);

      await expect(member.getByTestId('brainstorm-artifact-body')).toContainText('Decision Outcome');
      await expect(member.getByTestId('brainstorm-readonly-notice')).toBeVisible();
      await expect(member.getByTestId('brainstorm-artifact-type-select')).toBeDisabled();
      await expect(member.getByTestId('brainstorm-checkpoint-input')).toHaveCount(0);
      await expect(member.locator('[data-testid^="brainstorm-action-start-"]')).toHaveCount(0);
      await expect(member.locator('[data-testid^="brainstorm-suggestion-chip-"]')).toHaveCount(0);

      await member.getByTestId('brainstorm-history-open').click();
      await expect(member.getByTestId('brainstorm-version-row-3')).toBeVisible();
      await expect(member.locator('[data-testid^="brainstorm-rollback-"]')).toHaveCount(0);

      const refused = await member.request.post(api(`/${sessionId}/artifact/checkpoints`, E2E_PROJECT), {
        data: { name: 'Not mine', expectedVersion: 3 },
      });
      expect(refused.status()).toBe(403);
    } finally {
      await memberContext.close();
    }

    const outsideContext = await browser.newContext();
    const outside = await outsideContext.newPage();
    try {
      await stubAdoProjects(outside);
      await selectProject(outside, OTHER_PROJECT);
      await devLogin(outside, 'developer');
      const missing = await outside.request.get(api(`/${sessionId}/artifact`, OTHER_PROJECT));
      expect(missing.status()).toBe(404);
    } finally {
      await outsideContext.close();
    }
  });
});
