/**
 * VT-10 — FEAT-003 / PBI-006: pre-PR check results on a finished Cloud Agent run.
 *
 * Covers the browser-level acceptance criteria for a Developer viewing `/my-work`
 * with a completed Cloud Agent run on an Azure DevOps Feature row:
 *  - AC-0 / AC-1: a run that finished with a PR shows the View PR link and, when a
 *    suite failed, lists the failing check as text next to it (never colour alone).
 *  - AC-2: a run that finished without a PR shows "Run finished, no PR yet" and
 *    never claims any checks passed.
 *
 * The page is driven entirely by route stubs — project list, permissions, menu
 * config, feature flags, and the three `/api/dev-workbench` reads the row needs —
 * so the row state matrix is exercised without a provisioned ADO project, a real
 * Cloud Agent run, or seeded dev sessions.
 *
 * `current-run-checks-failing` / `current-run-checks-no-pr` come from
 * CurrentRunChecksSummary, which the row renders beside the PR link.
 *
 * Lower-tier substitutes (unit/integration):
 * - src/server/__tests__/runCheckResults.test.ts
 * - src/server/__tests__/devWorkbenchRoutes.test.ts
 * - src/client/components/__tests__/DevWorkbenchView.test.tsx
 */
import { test, expect, E2E_PROJECT } from '../support/fixtures';
import { stubAdoProjects, suppressSseStreams } from '../support/api-stubs';
import type { Page } from '@playwright/test';
import type {
  ActiveDevSession,
  AssignedWorkItem,
  CloudAgentRunSummary,
  DevSessionDetail,
} from '../../../src/shared/types/devWorkbench';
import type { EvaluateFlagsResponse } from '../../../src/shared/types/featureFlags';
import {
  MY_WORK_CLOUD_AGENT_FLAG,
  WORK_BOARD_FLAG,
} from '../../../src/shared/types/featureFlags';

const WORK_ITEM_ID = 4210;
const SESSION_ID = 'e2e-feat003-cloud-session';
const PR_URL = 'https://github.com/example/apex/pull/4210';
const NO_PR_COPY = 'Run finished, no PR yet';

const WORK_ITEM: AssignedWorkItem = {
  id: WORK_ITEM_ID,
  title: '[E2E] Pre-PR quality checks visibility',
  workItemType: 'Feature',
  state: 'In Progress',
  assignedTo: 'E2E Developer',
  project: E2E_PROJECT,
  areaPath: E2E_PROJECT,
  iterationPath: E2E_PROJECT,
  tags: 'apex',
  cloudAgentEligibility: { allowed: true },
};

/** Completed run that opened a PR and reported one failed e2e suite (AC-0 / AC-1). */
const RUN_WITH_PR_AND_FAILING_E2E: CloudAgentRunSummary = {
  runId: 'e2e-feat003-run-1',
  status: 'completed',
  prUrl: PR_URL,
  prStatus: 'open',
  finishedWithoutPr: false,
  terminalReason: null,
  checkResults: [
    { kind: 'unit', outcome: 'passed' },
    { kind: 'e2e', outcome: 'failed' },
    { kind: 'wcag', outcome: 'passed' },
  ],
  failingChecks: ['e2e'],
  lastError: null,
};

/** Completed run that never opened a PR and reported nothing (AC-2). */
const RUN_WITHOUT_PR: CloudAgentRunSummary = {
  runId: 'e2e-feat003-run-2',
  status: 'completed',
  prUrl: null,
  prStatus: 'none',
  finishedWithoutPr: true,
  terminalReason: null,
  checkResults: null,
  failingChecks: [],
  lastError: null,
};

/**
 * Active session carrying the run. `chatThreadId` and `branchName` stay null so the
 * row resolves this session as the Cloud Agent session only, keeping the legacy
 * Resume Session / Close Session controls out of the assertions.
 */
function activeSession(run: CloudAgentRunSummary): ActiveDevSession {
  return {
    id: SESSION_ID,
    workItemId: WORK_ITEM_ID,
    chatThreadId: null,
    branchName: null,
    status: 'in_progress',
    prUrl: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:30:00.000Z',
    cloudAgentRun: run,
    leftoverWork: null,
  };
}

function sessionDetail(run: CloudAgentRunSummary): DevSessionDetail {
  return {
    id: SESSION_ID,
    workItemId: WORK_ITEM_ID,
    chatThreadId: null,
    branchName: null,
    status: 'in_progress',
    setupError: null,
    setupPhase: null,
    setupDetail: null,
    setupProgressAt: null,
    prUrl: null,
    branchPushed: false,
    createdAt: '2026-09-01T12:00:00.000Z',
    cloudAgentRun: run,
    leftoverWork: null,
  };
}

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

/**
 * Minimum shell stubs for a Developer to reach `/my-work`: `dev-workbench:view`
 * plus the `my-work` menu item (App.tsx gates the route on both), the Cloud Agent
 * flag on, and the Work Board flag off so the ADO row list renders instead of the
 * board-assignment section.
 */
async function stubDeveloperShell(page: Page): Promise<void> {
  await page.route('**/api/me/permissions**', (route) =>
    route.fulfill(
      json({
        permissions: ['dev-workbench:view', 'home:view'],
        roles: ['member'],
        groups: ['Developer'],
        userId: 'e2e-developer',
        isSuperAdmin: false,
        changelogUnread: false,
        currentChangelogVersion: '0.0.0-e2e',
        lastSeenChangelogVersion: '0.0.0-e2e',
        showChangelogOnLogin: false,
        betaAnnouncementDismissed: true,
        whatsNew: {
          status: 'seeded',
          currentVersion: '0.0.0-e2e',
          lastSeenVersion: '0.0.0-e2e',
          unread: false,
          showOnLogin: false,
          seeded: true,
        },
        restrictedAccess: null,
      }),
    ),
  );

  await page.route('**/api/menu-config**', (route) =>
    route.fulfill(json({ enabledViews: ['my-work', 'home'] })),
  );

  const flags: EvaluateFlagsResponse = {
    flags: {
      [MY_WORK_CLOUD_AGENT_FLAG]: true,
      [WORK_BOARD_FLAG]: false,
      'beta-to-prod-announcement': false,
    },
  };
  await page.route('**/api/feature-flags/evaluate*', (route) => route.fulfill(json(flags)));
}

/** Stub the three dev-workbench reads the row consumes for one completed run. */
async function stubMyWorkRow(page: Page, run: CloudAgentRunSummary): Promise<void> {
  await page.route('**/api/dev-workbench/workitems*', (route) =>
    route.fulfill(json([WORK_ITEM])),
  );

  // Exact-path predicates keep the collection read and the detail poll apart —
  // a `**/sessions*` glob would swallow both.
  await page.route(
    (url) => url.pathname === '/api/dev-workbench/sessions',
    (route) => route.fulfill(json([activeSession(run)])),
  );

  await page.route(
    (url) => url.pathname === `/api/dev-workbench/sessions/${SESSION_ID}`,
    (route) => route.fulfill(json(sessionDetail(run))),
  );
}

test.describe('My Work — Cloud Agent check results @my-work-cloud-agent', () => {
  test.beforeEach(async ({ page }) => {
    await suppressSseStreams(page);
    await stubAdoProjects(page);
    await stubDeveloperShell(page);

    // Pin the active project so the row's queries and the flag evaluation all
    // resolve against an ADO-configured project instead of the VITE_TEAMS default.
    await page.addInitScript((project: string) => {
      window.localStorage.setItem('selectedProject', project);
      window.localStorage.setItem('selectedAreaPath', project);
    }, E2E_PROJECT);
  });

  test('PBI-006 AC-0/AC-1: a completed run with a PR shows the PR link and names the failing e2e suite', async ({
    page,
    loginAsPersona,
  }) => {
    await stubMyWorkRow(page, RUN_WITH_PR_AND_FAILING_E2E);
    await loginAsPersona('developer');
    await page.goto('/my-work');

    await expect(page.getByTestId('my-work-page')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('my-work-work-items-list')).toBeVisible();

    // AC-0: the PR the run opened is reachable from the row.
    const prLink = page.getByTestId(`my-work-cloud-run-pr-${WORK_ITEM_ID}`);
    await expect(prLink).toBeVisible();
    await expect(prLink).toHaveAttribute('href', PR_URL);
    await expect(prLink).toHaveText('View PR');

    // AC-1: the failed suite is named as text beside the PR link, and the PR
    // itself is still present — failing checks never gate the PR (BR-005).
    const failingChecks = page.getByTestId('current-run-checks-failing');
    await expect(failingChecks).toBeVisible();
    await expect(failingChecks).toContainText(/e2e/i);
    await expect(prLink).toBeVisible();
  });

  test('PBI-006 AC-2: a completed run without a PR reads "Run finished, no PR yet" and claims nothing passed', async ({
    page,
    loginAsPersona,
  }) => {
    await stubMyWorkRow(page, RUN_WITHOUT_PR);
    await loginAsPersona('developer');
    await page.goto('/my-work');

    await expect(page.getByTestId('my-work-page')).toBeVisible({ timeout: 15_000 });

    const noPr = page.getByTestId('current-run-checks-no-pr');
    await expect(noPr).toBeVisible();
    await expect(noPr).toHaveText(NO_PR_COPY);

    // No PR link, no failing-check list, and no success claim of any kind.
    await expect(page.getByTestId(`my-work-cloud-run-pr-${WORK_ITEM_ID}`)).toHaveCount(0);
    await expect(page.getByTestId('current-run-checks-failing')).toHaveCount(0);
    await expect(page.getByText(/checks passed/i)).toHaveCount(0);
  });
});
