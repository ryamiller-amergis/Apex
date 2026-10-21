/**
 * @interview-flow @pipeline
 * Manual SHA / re-ground controls are hidden; overnight idle re-ground owns freshness.
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

  test('hides SHA and re-ground controls while review actions stay enabled', async ({
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

    await expect(page.getByTestId('run-grounding-status')).toHaveCount(0);
    await expect(page.getByTestId('run-grounding-sha')).toHaveCount(0);
    await expect(page.getByTestId('run-grounding-reground-button')).toHaveCount(0);
    await expect(page.getByTestId('dd-submit-btn')).toBeEnabled();
  });

  test('hides grounding UI in Interview, PRD, and Design Doc run views', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const { interview, prd, doc } = await seedPipeline(e2eApi);
    await stubGroundingFlag(page, true);
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
  });
});
