/**
 * @interview-flow @pipeline
 * PBI-004 grounding drift, explicit confirmation, and flag-off behavior.
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

const shaA = 'a'.repeat(40);

async function stubGroundingFlag(
  page: Page,
  enabled: boolean,
): Promise<void> {
  await page.route('**/api/feature-flags/evaluate*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        flags: {
          'beta-to-prod-announcement': false,
          'repo-grounding-workspace-profile': enabled,
        },
      }),
    }),
  );
}

async function seedPipeline(
  e2eApi: Parameters<typeof SeedApi.seedPrd>[0],
) {
  const interview = await SeedApi.seedInterview(e2eApi, {
    authorId: PERSONA_OIDS.ba,
    project: E2E_PROJECT,
    title: 'Grounding continuity interview',
    status: 'complete',
    prdOwnerId: PERSONA_OIDS.ba,
    designDocOwnerId: PERSONA_OIDS.ba,
  });
  const prd = await SeedApi.seedPrd(e2eApi, {
    authorId: PERSONA_OIDS.ba,
    project: E2E_PROJECT,
    title: 'Grounding continuity PRD',
    status: 'approved',
    interviewId: interview.id,
    withReadyTestCases: true,
  });
  const doc = await SeedApi.seedDesignDoc(e2eApi, {
    prdId: prd.id,
    authorId: PERSONA_OIDS.ba,
    project: E2E_PROJECT,
    title: 'Grounding continuity design doc',
    status: 'draft',
    validationScore: 95,
  });
  return { interview, prd, doc };
}

test.describe('PBI-004 run grounding drift', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('AC-2 / VT-09 shows polite source-changed status while normal review controls remain enabled', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const { doc } = await seedPipeline(e2eApi);
    await stubGroundingFlag(page, true);
    await page.route(
      `**/api/run-groundings/design_doc/${doc.id}`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              runType: 'chat',
              runId: 'design-doc-thread',
              role: 'target',
              groundedSha: shaA,
              groundedShaShort: shaA.slice(0, 12),
              groundedAt: '2026-08-02T14:00:00.000Z',
              driftState: 'source-changed',
              canReGround: true,
            },
          ]),
        }),
    );
    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    await page.goto(`/backlog/design-doc/${doc.id}`);

    const notice = page.getByTestId('run-grounding-drift-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute('role', 'status');
    await expect(notice).toHaveAttribute('aria-live', 'polite');
    await expect(notice).toContainText(/source changed/i);
    await expect(page.getByTestId('run-grounding-sha')).toContainText(
      shaA.slice(0, 12),
    );
    await expect(page.getByTestId('dd-submit-btn')).toBeEnabled();
  });

  test('AC-3 / VT-10 Escape dismisses re-ground without changing SHA A and returns focus', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const { doc } = await seedPipeline(e2eApi);
    let reGroundPosts = 0;
    await stubGroundingFlag(page, true);
    await page.route(
      `**/api/run-groundings/design_doc/${doc.id}*`,
      (route) => {
        if (route.request().method() === 'POST') {
          reGroundPosts += 1;
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              runType: 'chat',
              runId: 'design-doc-thread',
              role: 'target',
              groundedSha: shaA,
              groundedShaShort: shaA.slice(0, 12),
              groundedAt: '2026-08-02T14:00:00.000Z',
              driftState: 'source-changed',
              canReGround: true,
            },
          ]),
        });
      },
    );
    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');
    await page.goto(`/backlog/design-doc/${doc.id}`);
    const trigger = page.getByTestId('run-grounding-reground-button');
    const pinnedText = await page.getByTestId('run-grounding-sha').innerText();

    await trigger.click();
    await expect(page.getByTestId('run-grounding-reground-confirm')).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('run-grounding-reground-confirm')).toHaveCount(0);
    await expect(page.getByTestId('run-grounding-sha')).toHaveText(pinnedText);
    await expect(trigger).toBeFocused();
    expect(reGroundPosts).toBe(0);
  });

  test('VT-11 flag off hides grounding UI in Interview, PRD, and Design Doc run views', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const { interview, prd, doc } = await seedPipeline(e2eApi);
    let groundingRequests = 0;
    await stubGroundingFlag(page, false);
    await page.route('**/api/run-groundings/**', (route) => {
      groundingRequests += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '[]',
      });
    });
    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    await page.goto(`/backlog/interview/${interview.id}`);
    await expect(page.getByTestId('interview-status-badge')).toBeVisible();
    await expect(page.getByTestId('run-grounding-status')).toHaveCount(0);

    await page.goto(`/backlog/prd/${prd.id}`);
    await expect(page.getByTestId('prd-review')).toBeVisible();
    await expect(page.getByTestId('run-grounding-status')).toHaveCount(0);

    await page.goto(`/backlog/design-doc/${doc.id}`);
    await expect(page.getByTestId('design-doc-review')).toBeVisible();
    await expect(page.getByTestId('run-grounding-status')).toHaveCount(0);
    expect(groundingRequests).toBe(0);
  });
});
