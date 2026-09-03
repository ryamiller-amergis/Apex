/**
 * VT-07 — FEAT-004 / PBI-007 AC-0: host-agnostic PR status on a My Work row.
 *
 * A Developer viewing `/my-work` with a finished Cloud Agent run sees `Open`
 * beside the PR link. Once the PR is merged on the host, the next session poll
 * moves the row to `Merged` — no page reload, no new endpoint, no SSE stream.
 * The status text carries the meaning on its own (visible-text NFR).
 *
 * The page is driven entirely by route stubs — project list, permissions, menu
 * config, feature flags, and the two `/api/dev-workbench` reads the row needs —
 * so the transition is exercised without a provisioned ADO project, a real
 * Cloud Agent run, seeded dev sessions, or any call to GitHub / Azure Repos.
 *
 * The poll cycle is driven by Playwright's clock rather than a 30-second wall
 * wait: the row's finished-run-with-open-PR cadence is
 * `PR_STATUS_POLL_INTERVAL_MS` (30s) in `useDevWorkbench.ts`.
 *
 * Author scoping is verified a tier down — `GET /sessions/:id` returns 404 with
 * no PR status for another author (PBI-007 AC-3 / VT-06 in
 * `src/server/__tests__/devWorkbenchRoutes.test.ts`), so this browser fixture
 * needs only the one Developer row.
 *
 * Lower-tier substitutes (unit/integration):
 * - src/server/__tests__/devWorkbenchRoutes.test.ts
 * - src/server/__tests__/cloudAgentService.test.ts
 * - src/client/hooks/__tests__/useDevWorkbench.test.ts
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

/** Mirrors `PR_STATUS_POLL_INTERVAL_MS` in `src/client/hooks/useDevWorkbench.ts`. */
const PR_STATUS_POLL_INTERVAL_MS = 30_000;

const WORK_ITEM_ID = 4211;
const SESSION_ID = 'e2e-feat004-pr-status-session';
const PR_URL = 'https://github.com/example/apex/pull/4211';

const WORK_ITEM: AssignedWorkItem = {
  id: WORK_ITEM_ID,
  title: '[E2E] Host-agnostic PR status on My Work',
  workItemType: 'Feature',
  state: 'In Progress',
  assignedTo: 'E2E Developer',
  project: E2E_PROJECT,
  areaPath: E2E_PROJECT,
  iterationPath: E2E_PROJECT,
  tags: 'apex',
  cloudAgentEligibility: { allowed: true },
};

/** Finished GitHub-hosted run whose PR is still open. */
const RUN_PR_OPEN: CloudAgentRunSummary = {
  runId: 'e2e-feat004-run-1',
  status: 'completed',
  prUrl: PR_URL,
  prStatus: 'open',
  finishedWithoutPr: false,
  terminalReason: null,
  checkResults: null,
  failingChecks: [],
  lastError: null,
};

/** Same run after the PR was merged on GitHub — only `prStatus` moves. */
const RUN_PR_MERGED: CloudAgentRunSummary = { ...RUN_PR_OPEN, prStatus: 'merged' };

/**
 * Active session carrying the run. `chatThreadId` and `branchName` stay null so
 * the row resolves this session as the Cloud Agent session only, keeping the
 * legacy Resume Session / Close Session controls out of the assertions.
 */
function activeSession(run: CloudAgentRunSummary): ActiveDevSession {
  return {
    id: SESSION_ID,
    workItemId: WORK_ITEM_ID,
    chatThreadId: null,
    branchName: null,
    status: 'in_progress',
    prUrl: null,
    createdAt: '2026-09-02T12:00:00.000Z',
    updatedAt: '2026-09-02T12:30:00.000Z',
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
    createdAt: '2026-09-02T12:00:00.000Z',
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

/**
 * Stub the dev-workbench reads the row consumes. The detail route serves
 * whatever `state.run` currently holds, so the test can merge the fixture PR
 * between polls the way the host would.
 */
async function stubMyWorkRow(page: Page, state: { run: CloudAgentRunSummary }): Promise<void> {
  await page.route('**/api/dev-workbench/workitems*', (route) =>
    route.fulfill(json([WORK_ITEM])),
  );

  // Exact-path predicates keep the collection read and the detail poll apart —
  // a `**/sessions*` glob would swallow both.
  await page.route(
    (url) => url.pathname === '/api/dev-workbench/sessions',
    (route) => route.fulfill(json([activeSession(RUN_PR_OPEN)])),
  );

  await page.route(
    (url) => url.pathname === `/api/dev-workbench/sessions/${SESSION_ID}`,
    (route) => route.fulfill(json(sessionDetail(state.run))),
  );
}

test.describe('My Work — Cloud Agent PR status @my-work-cloud-agent', () => {
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

  test('PBI-007 AC-0 / VT-07: an open PR reads "Open" and moves to "Merged" on the next poll without a reload', async ({
    page,
    loginAsPersona,
  }) => {
    const state = { run: RUN_PR_OPEN };
    await stubMyWorkRow(page, state);
    await loginAsPersona('developer');

    // Fake timers must be installed before the page scripts run so the row's
    // 30s PR-status poll is scheduled on the clock this test controls.
    await page.clock.install();
    await page.goto('/my-work');

    await expect(page.getByTestId('my-work-page')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('my-work-work-items-list')).toBeVisible();

    // The PR the run opened is reachable from the row, and the status text sits
    // in the same run controls as that link.
    const prLink = page.getByTestId(`my-work-cloud-run-pr-${WORK_ITEM_ID}`);
    await expect(prLink).toBeVisible();
    await expect(prLink).toHaveAttribute('href', PR_URL);

    const runControls = prLink.locator('xpath=..');
    const prStatus = runControls.getByTestId('my-work-row-pr-status');
    await expect(prStatus).toBeVisible();
    await expect(prStatus).toHaveText('Open');

    // Mark the live document so a reload would be detectable, then merge the
    // fixture PR on the host side.
    await page.evaluate(() => {
      (window as unknown as { __vt07DocumentAlive?: boolean }).__vt07DocumentAlive = true;
    });
    state.run = RUN_PR_MERGED;

    // Advance past one PR-status poll interval. The row refetches the session it
    // already polls — no reload, no second endpoint.
    await page.clock.fastForward(PR_STATUS_POLL_INTERVAL_MS + 1_000);

    await expect(prStatus).toHaveText('Merged', { timeout: 15_000 });
    await expect(prLink).toHaveAttribute('href', PR_URL);
    expect(
      await page.evaluate(
        () => (window as unknown as { __vt07DocumentAlive?: boolean }).__vt07DocumentAlive === true,
      ),
    ).toBe(true);
  });
});
