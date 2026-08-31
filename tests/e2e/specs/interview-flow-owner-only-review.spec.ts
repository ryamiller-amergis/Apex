/**
 * @interview-flow @pipeline
 * FEAT-002 Wave 4 S12: reviewer availability and owner-only ADR review.
 */
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  SeedApi,
  PERSONA_OIDS,
  E2E_PROJECT,
} from '../support/fixtures';
import { stubAdoProjects, stubAllAiTraffic } from '../support/api-stubs';

async function prepareInteractiveKickoff(page: Page): Promise<void> {
  await stubAdoProjects(page);
  await stubAllAiTraffic(page);
  // The generic AI stub supplies a fake thread id. These scenarios persist the
  // real Interview/ADR, so only thread creation continues to the E2E server.
  await page.route('**/api/chat/threads', async (route) => {
    if (route.request().method() === 'POST') {
      await route.continue();
    } else {
      await route.fallback();
    }
  });
}

async function openInterviewOwnerStep(page: Page, title: string): Promise<void> {
  await page.goto('/backlog/interview/new');
  await page.getByTestId('interview-compose-title').fill(title);
  await page.getByTestId('interview-compose-message').fill(
    'Exercise deterministic reviewer availability during kickoff.',
  );
  await expect(page.getByTestId('interview-compose-start')).toBeEnabled({
    timeout: 15_000,
  });
  await page.getByTestId('interview-compose-start').click();
  await expect(page.getByTestId('section-owner-modal')).toBeVisible();
}

async function selectOwner(page: Page, inputTestId: string, userName: string): Promise<void> {
  const input = page.getByTestId(inputTestId);
  await expect(input).toBeVisible();
  await input.fill(userName);
  await input.press('ArrowDown');
  await input.press('Enter');
}

async function selectCoreOwners(page: Page): Promise<void> {
  await selectOwner(page, 'so-prd-owner-input', 'BA Dev User');
  await selectOwner(page, 'so-dd-owner-input', 'Dev User');
}

test.describe('FEAT-002 owner-only review @interview-flow @pipeline', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('PBI-004 AC-0 renders only the PRD reviewer picker when Design Doc has no available reviewers', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    await SeedApi.seedProjectSettings(e2eApi, {
      project: E2E_PROJECT,
      friendlyName: 'PRD Reviewers Only',
      isDefault: true,
      approvalMode: 'any_one',
      prototypeStageEnabled: false,
      testCaseSkillPath: null,
      prdApprovers: [PERSONA_OIDS.qa],
    });
    await prepareInteractiveKickoff(page);
    await loginAsPersona('product-owner');

    await openInterviewOwnerStep(page, '[E2E] PRD-only reviewer kickoff');
    await selectCoreOwners(page);
    await page.getByTestId('section-owner-next-btn').click();

    await expect(page.getByTestId('reviewer-picker-prd')).toBeVisible();
    await expect(page.getByTestId('reviewer-picker-design-doc')).toHaveCount(0);
    await expect(page.getByText('Design Doc Reviewers', { exact: true })).toHaveCount(0);
  });

  test('PBI-004 AC-2 skips reviewer step and starts an Interview with empty reviewer assignments', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    await SeedApi.seedProjectSettings(e2eApi, {
      project: E2E_PROJECT,
      friendlyName: 'Owner-only Interview',
      isDefault: true,
      approvalMode: 'any_one',
      prototypeStageEnabled: false,
      testCaseSkillPath: null,
    });
    await prepareInteractiveKickoff(page);
    await loginAsPersona('product-owner');

    await openInterviewOwnerStep(page, '[E2E] Owner-only Interview');
    await selectCoreOwners(page);

    await expect(page.getByTestId('section-owner-next-btn')).toHaveCount(0);
    await expect(page.getByText(/Step 2/)).toHaveCount(0);
    const start = page.getByTestId('confirm-start-interview-no-reviewers');
    await expect(start).toBeVisible();

    const createRequestPromise = page.waitForRequest((request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/interviews',
    );
    await start.click();
    const createRequest = await createRequestPromise;
    expect(createRequest.postDataJSON()).toEqual(expect.objectContaining({
      prdApproverIds: [],
      designDocApproverIds: [],
      designPrototypeApproverIds: [],
      testCaseApproverIds: [],
    }));
    await expect(page).toHaveURL(/\/backlog\/interview\/[^/]+$/, { timeout: 20_000 });
  });

  test('PBI-005 AC-2 skips the ADR reviewer modal and directly creates an owner-only ADR', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    await SeedApi.seedProjectSettings(e2eApi, {
      project: E2E_PROJECT,
      friendlyName: 'Owner-only ADR',
      isDefault: true,
      approvalMode: 'any_one',
    });
    await prepareInteractiveKickoff(page);
    await loginAsPersona('product-owner');

    await page.goto('/adr');
    await page.getByRole('button', { name: /Start New ADR/i }).click();
    await page.getByTestId('adr-compose-title').fill('[E2E] Owner-only ADR');
    await page.getByTestId('adr-compose-message').fill(
      'Choose a path when the ADR reviewer pool resolves no available members.',
    );

    const start = page.getByTestId('create-adr-no-reviewers');
    await expect(start).toBeEnabled({ timeout: 15_000 });
    await expect(page.getByTestId('adr-reviewer-modal')).toHaveCount(0);
    const createRequestPromise = page.waitForRequest((request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/adrs',
    );
    await start.click();
    const createRequest = await createRequestPromise;
    expect(createRequest.postDataJSON()).toEqual(expect.objectContaining({ reviewerIds: [] }));
    await expect(page.getByTestId('adr-reviewer-modal')).toHaveCount(0);
    await expect(page).toHaveURL(/\/adr\/[^/]+$/, { timeout: 20_000 });
  });

  test('PBI-007 AC-0 / PBI-006 owner-only ADR supports comments and one-step owner acceptance', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const settings = await SeedApi.seedProjectSettings(e2eApi, {
      project: E2E_PROJECT,
      friendlyName: 'ADR pool changed after snapshot',
      isDefault: true,
      approvalMode: 'any_one',
      adrApprovers: [PERSONA_OIDS.qa],
    });
    const adr = await SeedApi.seedAdr(e2eApi, {
      authorId: PERSONA_OIDS['product-owner'],
      project: E2E_PROJECT,
      title: 'Owner-only ADR approval',
      status: 'proposed',
      reviewerIds: [],
      skillSettingsId: settings.id,
      content: '# Owner-only decision\n\n## Decision\n\nAdopt the deterministic review path.',
    });
    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('product-owner');

    await page.goto(`/adr/${adr.id}`);
    await expect(page.getByRole('heading', { name: adr.title })).toBeVisible();
    await expect(page.getByTestId('adr-manage-reviewers-btn')).toHaveCount(0);
    await expect(page.getByTestId('adr-request-revision-btn')).toHaveCount(0);
    await expect(page.getByTestId('comment-sidebar')).toBeVisible();
    await expect(page.getByText(/No reviewer approval required/)).toBeVisible();

    const accept = page.getByTestId('adr-accept-btn');
    await expect(accept).toBeEnabled();
    const acceptResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/adrs/${adr.id}/owner-approve`,
    );
    await accept.click();
    await expect((await acceptResponse).ok()).toBe(true);
    await expect(page.getByText(/· accepted ·/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('adr-accept-btn')).toHaveCount(0);
  });
});
