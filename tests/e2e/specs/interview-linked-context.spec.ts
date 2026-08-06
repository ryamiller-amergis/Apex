/**
 * VT-10 / PBI-003 AC-0 + PBI-004 AC-0
 * Linked Interview context survives kickoff creation and supports remove/undo.
 */
import type { Page, Route } from '@playwright/test';
import { test, expect, SeedApi } from '../support/fixtures';
import { stubAdoProjects, stubAllAiTraffic } from '../support/api-stubs';

const ADR = {
  type: 'adr' as const,
  id: 'e2e-linked-adr',
  title: 'Accepted checkout architecture',
  status: 'accepted' as const,
};

const DESIGN_MODULE = {
  type: 'design-module' as const,
  id: 'e2e-linked-design-module',
  name: 'Checkout Design Module',
};

type LinkedType = 'adr' | 'design-module';

async function stubStatefulLinkedContext(page: Page): Promise<void> {
  const linked = new Set<string>();
  let interviewId = '';

  const readModel = () => ({
    interviewId,
    adrLinks: linked.has(`adr:${ADR.id}`)
      ? [{
          adrId: ADR.id,
          title: ADR.title,
          isAccepted: true,
          linkedBy: 'e2e-product-owner',
          linkedAt: '2026-08-06T00:00:00.000Z',
        }]
      : [],
    designModuleLinks: linked.has(`design-module:${DESIGN_MODULE.id}`)
      ? [{
          designModuleId: DESIGN_MODULE.id,
          name: DESIGN_MODULE.name,
          linkedBy: 'e2e-product-owner',
          linkedAt: '2026-08-06T00:00:00.000Z',
        }]
      : [],
    count: linked.size,
    capacity: 10,
  });

  const fulfillJson = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

  await page.route(
    /\/api\/interviews(?:\/[^/?]+)?\/link-candidates(?:\?|$)/,
    async (route) => {
      const url = new URL(route.request().url());
      const type = url.searchParams.get('type');
      const item = type === 'design-module' ? DESIGN_MODULE : ADR;
      await fulfillJson(route, {
        items: [item],
        total: 1,
        offset: 0,
        limit: 50,
      });
    },
  );

  await page.route(/\/api\/interviews\/([^/?]+)\/links(?:\/.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const match = url.pathname.match(/^\/api\/interviews\/([^/]+)\/links(?:\/(.*))?$/);
    if (!match) {
      await route.fallback();
      return;
    }

    interviewId = decodeURIComponent(match[1]);
    const suffix = match[2];

    if (request.method() === 'GET' && !suffix) {
      await fulfillJson(route, readModel());
      return;
    }

    const segments = suffix?.split('/') ?? [];
    const type = segments[0] as LinkedType | undefined;
    if (request.method() === 'POST' && type) {
      const body = request.postDataJSON() as {
        adrId?: string;
        designModuleId?: string;
      };
      const id = type === 'adr' ? body.adrId : body.designModuleId;
      if (id) linked.add(`${type}:${id}`);
      await fulfillJson(route, { linkedContext: readModel() });
      return;
    }

    if (request.method() === 'DELETE' && type && segments[1]) {
      linked.delete(`${type}:${decodeURIComponent(segments[1])}`);
      await fulfillJson(route, { linkedContext: readModel() });
      return;
    }

    await route.fallback();
  });
}

async function selectOwner(
  page: Page,
  label: string,
  userName: string,
  required = true,
): Promise<void> {
  const ownerInput = page.getByLabel(label);
  if (required) {
    await expect(ownerInput).toBeVisible();
  } else if (!(await ownerInput.isVisible().catch(() => false))) {
    return;
  }
  await ownerInput.fill(userName);
  await ownerInput.press('ArrowDown');
  await ownerInput.press('Enter');
}

test.describe('Interview linked context @interview-flow @pipeline @a11y', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('VT-10 AC-0: kickoff links persist and remove Undo restores the final set', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await stubStatefulLinkedContext(page);

    // Let kickoff create a real chat thread while all message/AI traffic remains stubbed.
    await page.route('**/api/chat/threads', async (route) => {
      if (route.request().method() === 'POST') {
        await route.continue();
      } else {
        await route.fallback();
      }
    });

    await loginAsPersona('product-owner');

    // Given an accepted ADR and Design Module staged during Interview kickoff.
    await page.goto('/backlog/interview/new');
    const picker = page.getByTestId('linked-context-picker');
    await expect(picker).toBeVisible();

    const addAdr = page.getByTestId(`linked-context-add-adr-${ADR.id}`);
    await addAdr.focus();
    await expect(addAdr).toBeFocused();
    await addAdr.press('Enter');
    await expect(page.getByTestId(`linked-context-link-adr-${ADR.id}`)).toBeVisible();
    await expect(page.getByTestId('linked-context-status')).toContainText(`Added ${ADR.title}.`);

    const designModuleFilter = page.getByTestId('linked-context-filter-design-module');
    await designModuleFilter.focus();
    await designModuleFilter.press('Enter');
    await page.getByTestId(`linked-context-add-design-module-${DESIGN_MODULE.id}`).click();
    await expect(
      page.getByTestId(`linked-context-link-design-module-${DESIGN_MODULE.id}`),
    ).toBeVisible();

    await page.getByTestId('interview-compose-title').fill('[E2E] Linked Context Round Trip');
    await page.getByTestId('interview-compose-message').fill(
      'Ground this interview with the selected architecture context.',
    );
    await expect(page.getByTestId('interview-compose-start')).toBeEnabled({
      timeout: 15_000,
    });

    // When the Product Owner creates the Interview through the normal owner flow.
    await page.getByTestId('interview-compose-start').click();
    const ownerDialog = page.getByRole('dialog', { name: 'Assign Owners & Reviewers' });
    await expect(ownerDialog).toBeVisible();
    await selectOwner(page, 'PRD Owner (BA) *', 'BA Dev User');
    await selectOwner(page, 'Design Doc Owner (Developer) *', 'Dev User');
    await selectOwner(
      page,
      'Design Prototype Owner (UI/UX) *',
      'UI/UX Dev User',
      false,
    );
    await selectOwner(page, 'Test Case Owner (QA) *', 'QA Dev User', false);
    await ownerDialog.getByRole('button', { name: /Next/ }).click();

    for (const sectionName of [
      'PRD Reviewers *',
      'Design Doc Reviewers *',
      'Design Prototype Reviewers *',
      'QA Reviewers *',
    ]) {
      const sectionLabel = ownerDialog.getByText(sectionName, { exact: true });
      if (await sectionLabel.isVisible().catch(() => false)) {
        const buttons = sectionLabel.locator('..').getByRole('button');
        if ((await buttons.count()) > 0) await buttons.first().click();
      }
    }

    await ownerDialog.getByRole('button', { name: 'Confirm & Start Interview' }).click();
    await expect(page).toHaveURL(/\/backlog\/interview\/[^/]+$/, { timeout: 20_000 });

    // Then both links are authoritative in the persisted panel.
    const trigger = page.getByTestId('interview-linked-context-trigger');
    await trigger.focus();
    await trigger.press('Enter');
    const panel = page.getByTestId('interview-linked-context-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId(`linked-context-link-adr-${ADR.id}`)).toBeVisible();
    await expect(
      panel.getByTestId(`linked-context-link-design-module-${DESIGN_MODULE.id}`),
    ).toBeVisible();
    await expect(panel.getByTestId('linked-context-capacity')).toContainText('2 of 10 linked.');

    // And remove followed by Undo restores the persisted final set.
    await panel.getByTestId(`linked-context-remove-adr-${ADR.id}`).click();
    await expect(panel.getByTestId(`linked-context-link-adr-${ADR.id}`)).toHaveCount(0);
    await expect(panel.getByTestId('linked-context-undo')).toBeVisible();
    await panel.getByTestId('linked-context-undo').click();
    await expect(panel.getByTestId(`linked-context-link-adr-${ADR.id}`)).toBeVisible();
    await expect(panel.getByTestId('linked-context-status')).toContainText(`Restored ${ADR.title}.`);
    await expect(panel.getByTestId('linked-context-capacity')).toContainText('2 of 10 linked.');

    // Final VT-09 check: Escape closes the modal panel and restores trigger focus.
    await panel.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
