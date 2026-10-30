/**
 * FEAT-008 — Build Run View (VT-35): header, Plan tab, keyboard tabs, reload on Timeline, flag-off banner.
 *
 * The seed API cannot create build rows, so the spec stubs the detail and events routes and the flag
 * evaluation, as the other build specs do. The server rules are covered by `buildRunRoutes.test.ts`
 * and `buildRunProjectionService.test.ts`.
 */
import type { Page } from '@playwright/test';
import { expect, test, E2E_PROJECT, SeedApi } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';
import { DEFAULT_ENABLED_MENU_VIEWS } from '../../../src/shared/types/menuSettings';
import type { BuildDetailResponse, BuildEventsResponse, BuildTaskView } from '../../../src/shared/types/buildView';

const BUILD_ID = '00000000-0000-4000-8000-0000000000e2';

function task(key: string, status: BuildTaskView['status'], dependsOn: string[] = []): BuildTaskView {
  return {
    key,
    role: 'implementer',
    dependsOn,
    ownedFiles: [`src/${key}.ts`],
    reuse: [],
    runMode: 'own_agent',
    branch: `apex/build/${BUILD_ID}/${key}`,
    status,
    attempt: 1,
    omittedReason: null,
  };
}

const DETAIL: BuildDetailResponse = {
  build: {
    id: BUILD_ID,
    project: E2E_PROJECT,
    repository: 'apex',
    status: 'building',
    currentRevisionNumber: 1,
    intakeInterviewId: null,
    createdAt: '2026-10-28T10:00:00.000Z',
    endedAt: null,
  },
  stage: { kind: 'stage', key: 'building', tasks: { merged: 3, total: 5 }, queuePosition: null, suspendReason: null },
  timing: { elapsedSeconds: 125, targetSeconds: 300, state: 'within', includesDeployment: true },
  caps: {
    cost: { usedUsd: '1.0000', limitUsd: '25.0000' },
    revisions: { used: 0, limit: 5 },
    elapsedSeconds: { used: 125, limit: 3600 },
    parallelism: { used: 2, limit: 3 },
  },
  supportContacts: [{ displayName: 'Dana', email: 'dana@example.com' }],
  revisions: [{ number: 1, createdAt: '2026-10-28T10:00:00.000Z', classification: 'small', deploymentStatus: 'not_started', previewUrl: null }],
  currentRevision: {
    number: 1,
    classification: 'small',
    repairAttempts: 0,
    brief: { status: 'ok', overview: null, requirements: [], assumptions: [], exclusions: [], riskDecisions: [] },
    tasks: [
      task('a', 'merged'),
      task('b', 'merged'),
      task('c', 'merged', ['a']),
      task('d', 'running', ['c']),
      task('e', 'pending', ['d']),
    ],
  },
  verificationSummary: { total: 0, pass: 0, fail: 0, deferred: 0, retired: 0 },
  lease: null,
};

const EVENTS: BuildEventsResponse = {
  events: [{ id: 'e1', occurredAt: '2026-10-28T10:00:00.000Z', kind: 'task.merged', message: 'Task a merged.', taskKey: 'a' }],
  total: 1,
};

async function selectProject(page: Page): Promise<void> {
  await page.addInitScript((p) => {
    window.localStorage.setItem('selectedProject', p);
    window.localStorage.setItem('selectedAreaPath', p);
  }, E2E_PROJECT);
}

async function forceBuildFlag(page: Page, enabled: boolean): Promise<void> {
  await page.route('**/api/feature-flags/evaluate*', async (route) => {
    const response = await route.fetch();
    const data = (await response.json().catch(() => ({}))) as { flags?: Record<string, boolean> };
    await route.fulfill({ response, json: { ...data, flags: { ...(data.flags ?? {}), 'build-from-prompt': enabled } } });
  });
}

async function stubBuildRoutes(page: Page): Promise<void> {
  await page.route(`**/api/builds/${BUILD_ID}/events*`, (route) => route.fulfill({ json: EVENTS }));
  await page.route(`**/api/builds/${BUILD_ID}?*`, (route) => route.fulfill({ json: DETAIL }));
}

test.describe('Build Run View @feat-008', () => {
  test.beforeEach(async ({ page, request }) => {
    await SeedApi.setMenuSettings(request, E2E_PROJECT, [...DEFAULT_ENABLED_MENU_VIEWS, 'builds']);
    await stubAdoProjects(page);
    await stubBuildRoutes(page);
    await selectProject(page);
  });

  test('VT-35 PBI-016 AC-2, PBI-017 AC-0, PBI-018 AC-0: header, plan, keyboard tabs and reload', async ({ page, loginAsPersona }) => {
    await forceBuildFlag(page, true);
    await loginAsPersona('developer');
    await page.goto(`/builds/${BUILD_ID}/plan`);

    await expect(page.getByTestId('build-run-stage-text')).toHaveText('Building, 3 of 5 tasks');
    await expect(page.getByTestId('build-plan-task')).toHaveCount(5);

    await page.getByTestId('build-run-tab-plan').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('build-run-tab-timeline')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/builds/${BUILD_ID}/timeline$`));
    await expect(page.getByTestId('build-timeline-event')).toHaveCount(1);

    await page.reload();
    await expect(page.getByTestId('build-run-tab-timeline')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('build-timeline-list')).toBeVisible();
    await expect(page.getByTestId('build-run-flag-off-banner')).toHaveCount(0);
  });

  test('VT-35 TBI-014: with the flag off the build stays readable with a banner', async ({ page, loginAsPersona }) => {
    await forceBuildFlag(page, false);
    await loginAsPersona('developer');
    await page.goto(`/builds/${BUILD_ID}`);

    await expect(page.getByTestId('build-run-flag-off-banner'))
      .toHaveText('Builds are turned off for this project. You can still read this build.');
    await expect(page.getByTestId('build-run-stage-text')).toHaveText('Building, 3 of 5 tasks');
    await expect(page.getByTestId('build-run-actions')).toHaveCount(0);
  });
});
