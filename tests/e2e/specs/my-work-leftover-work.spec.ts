import type { Page } from '@playwright/test';
import { expect, test, E2E_PROJECT } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';

const NON_CLEAN_SESSION_ID = 'e2e-cloud-session-leftover';
const CLEAN_SESSION_ID = 'e2e-cloud-session-clean';
const CREATED_AT = '2026-09-02T12:00:00.000Z';

const completedRun = (runId: string, prUrl: string | null) => ({
  runId,
  status: 'completed',
  prUrl,
  finishedWithoutPr: !prUrl,
  terminalReason: null,
  checkResults: null,
  failingChecks: prUrl ? [] : ['unit'],
});

const sessions = [
  {
    id: NON_CLEAN_SESSION_ID,
    workItemId: 5005,
    chatThreadId: null,
    branchName: null,
    status: 'completed',
    prUrl: null,
    createdAt: CREATED_AT,
    cloudAgentRun: completedRun('e2e-run-leftover', null),
    leftoverWork: {
      failingChecks: ['unit'],
      missingPr: true,
      incompleteAcceptanceCriteria: [],
    },
  },
  {
    id: CLEAN_SESSION_ID,
    workItemId: 5006,
    chatThreadId: null,
    branchName: null,
    status: 'completed',
    prUrl: 'https://github.com/example/apex/pull/5006',
    createdAt: CREATED_AT,
    cloudAgentRun: completedRun(
      'e2e-run-clean',
      'https://github.com/example/apex/pull/5006',
    ),
    leftoverWork: {
      failingChecks: [],
      missingPr: false,
      incompleteAcceptanceCriteria: [],
    },
  },
];

async function stubMyWorkApis(page: Page): Promise<void> {
  await stubAdoProjects(page);

  await page.route('**/api/feature-flags/evaluate*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        flags: {
          'beta-to-prod-announcement': false,
          'my-work-cloud-agent': true,
          'work-board': false,
        },
      }),
    }),
  );

  await page.route('**/api/dev-workbench/workitems*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 5005,
          title: 'Cloud run with remaining work',
          workItemType: 'Feature',
          state: 'In Progress',
          assignedTo: 'developer@example.com',
          project: E2E_PROJECT,
          tags: 'apex',
          cloudAgentEligibility: { allowed: true },
        },
        {
          id: 5006,
          title: 'Clean cloud run',
          workItemType: 'Feature',
          state: 'In Progress',
          assignedTo: 'developer@example.com',
          project: E2E_PROJECT,
          tags: 'apex',
          cloudAgentEligibility: { allowed: true },
        },
      ]),
    }),
  );

  await page.route('**/api/dev-workbench/sessions*', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/dev-workbench/sessions') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sessions),
      });
    }

    const sessionId = pathname.split('/').pop();
    const session = sessions.find((candidate) => candidate.id === sessionId);
    return route.fulfill({
      status: session ? 200 : 404,
      contentType: 'application/json',
      body: JSON.stringify(
        session
          ? {
              ...session,
              setupError: null,
              setupPhase: null,
              setupDetail: null,
              setupProgressAt: null,
              branchPushed: false,
            }
          : { error: 'Session not found' },
      ),
    });
  });
}

test.describe('My Work leftover work', () => {
  test('shows a non-clean cloud row and omits the list for a clean row', async ({
    page,
    loginAsPersona,
  }) => {
    await page.addInitScript((project) => {
      window.localStorage.setItem('selectedProject', project);
      window.localStorage.setItem('selectedAreaPath', project);
    }, E2E_PROJECT);
    await stubMyWorkApis(page);
    await loginAsPersona('developer');

    await page.goto('/my-work');

    const nonClean = page.getByTestId(
      `my-work-leftover-work-${NON_CLEAN_SESSION_ID}`,
    );
    await expect(nonClean).toBeVisible();
    await expect(nonClean).toContainText('Failing check: unit');
    await expect(nonClean).toContainText(
      'No pull request was opened — no PR yet',
    );
    await expect(
      page.getByTestId(`my-work-leftover-work-${CLEAN_SESSION_ID}`),
    ).toHaveCount(0);
  });
});
