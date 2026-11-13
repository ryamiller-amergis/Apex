/**
 * @smoke
 * AC: planning-releases-revamp
 *
 * Covers the Planning & Generic Release Management revamp:
 * - Workflow 1: Legacy sub-tabs (Developer Stats, QA Metrics, AI Analysis) are removed;
 *   only Roadmap and Releases appear, and legacy URLs (/planning/dev-stats) redirect cleanly.
 * - Workflow 2: Team-agnostic target platforms (Desktop + Mobile via real DB endpoints),
 *   Slated Release Overview, Platform Readiness Matrix, lifecycle/platform filters,
 *   expanded release QA validation filters/grouping, work-item platform tagging,
 *   and drag-moving a work item across releases with updated completion & validation counts.
 */
import type { Page } from '@playwright/test';
import { test, expect, SeedApi, E2E_PROJECT } from '../support/fixtures';
import {
  stubAdoProjects,
  stubAdoWorkItems,
  suppressBetaAnnouncement,
  suppressSseStreams,
} from '../support/api-stubs';
import { PlanningReleasesPage } from '../pages/planning-releases.page';

interface StubReleaseChild {
  id: number;
  title: string;
  state: string;
  workItemType: string;
  assignedTo?: string;
  tags: string;
}

interface StubReleaseEpic {
  id: number;
  version: string;
  status: string;
  startDate: string;
  targetDate: string;
  description: string;
  items: StubReleaseChild[];
}

function serializeEpic(epic: StubReleaseEpic) {
  const greenStates = ['Ready For Release', 'UAT - Test Done', 'Done', 'Closed'];
  const amberStates = ['UAT - Ready For Test', 'UAT Ready For Test', 'UAT-Ready For Test'];
  let greenItems = 0;
  let amberItems = 0;
  let redItems = 0;

  for (const item of epic.items) {
    if (greenStates.includes(item.state)) greenItems += 1;
    else if (amberStates.includes(item.state)) amberItems += 1;
    else redItems += 1;
  }

  const totalItems = epic.items.length;
  return {
    id: epic.id,
    version: epic.version,
    status: epic.status,
    startDate: epic.startDate,
    targetDate: epic.targetDate,
    description: epic.description,
    tags: 'ReleaseVersion',
    totalItems,
    completedItems: greenItems,
    greenItems,
    amberItems,
    redItems,
    progress: totalItems > 0 ? Math.round((greenItems / totalItems) * 100) : 0,
    childItemsSummary: epic.items.map((i) => ({
      id: i.id,
      state: i.state,
      workItemType: i.workItemType,
      tags: i.tags,
    })),
  };
}

function serializeRelatedItems(items: StubReleaseChild[]) {
  const now = '2026-11-13T10:00:00.000Z';
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    state: item.state,
    workItemType: item.workItemType,
    assignedTo: item.assignedTo,
    tags: item.tags,
    areaPath: E2E_PROJECT,
    iterationPath: E2E_PROJECT,
    changedDate: now,
    createdDate: now,
  }));
}

async function stubReleaseAdoEndpoints(page: Page, epicsState: StubReleaseEpic[]) {
  await page.route('**/api/deployments*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  await page.route('**/api/epics/*/children*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  await page.route('**/api/features/*/children*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  // Intercept ADO-backed /api/releases* endpoints while letting DB-backed
  // /api/releases/platforms*, /api/releases/:epicId/platforms,
  // /api/releases/work-items/:id/platforms, and /api/releases/order hit Express + Postgres!
  await page.route(/\/api\/releases(?:\/|\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method().toUpperCase();

    if (
      pathname.startsWith('/api/releases/platforms') ||
      pathname.startsWith('/api/releases/work-items/') ||
      /^\/api\/releases\/\d+\/platforms$/.test(pathname) ||
      pathname === '/api/releases/order'
    ) {
      return route.continue();
    }

    if (pathname === '/api/releases/epics' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(epicsState.map(serializeEpic)),
      });
    }

    if (pathname === '/api/releases' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    }

    const relatedMatch = pathname.match(/^\/api\/releases\/(\d+)\/related-items$/);
    if (relatedMatch && method === 'GET') {
      const epicId = Number(relatedMatch[1]);
      const found = epicsState.find((e) => e.id === epicId);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(serializeRelatedItems(found?.items ?? [])),
      });
    }

    const linkMatch = pathname.match(/^\/api\/releases\/(\d+)\/link-related$/);
    if (linkMatch && method === 'POST') {
      const targetEpicId = Number(linkMatch[1]);
      const payload = (route.request().postDataJSON() ?? {}) as { workItemIds?: number[] };
      const idsToMove = new Set(payload.workItemIds ?? []);
      const movedItems: StubReleaseChild[] = [];
      let movedCount = 0;

      for (const epic of epicsState) {
        if (epic.id === targetEpicId) continue;
        const staying: StubReleaseChild[] = [];
        for (const item of epic.items) {
          if (idsToMove.has(item.id)) {
            movedItems.push(item);
            movedCount += 1;
          } else {
            staying.push(item);
          }
        }
        epic.items = staying;
      }

      const targetEpic = epicsState.find((e) => e.id === targetEpicId);
      if (targetEpic) {
        const existingIds = new Set(targetEpic.items.map((i) => i.id));
        for (const moved of movedItems) {
          if (!existingIds.has(moved.id)) {
            targetEpic.items.push(moved);
          }
        }
      }

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          linkedCount: idsToMove.size,
          movedCount,
          unchangedCount: 0,
          movedFrom: {},
        }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });
}

test.describe('Planning & Generic Release Management revamp @smoke', () => {
  test.beforeEach(async ({ page, e2eApi }) => {
    await suppressSseStreams(page);
    await suppressBetaAnnouncement(page);
    await SeedApi.setMenuSettings(e2eApi, E2E_PROJECT, ['calendar', 'planning', 'backlog']);
    await page.addInitScript((proj: string) => {
      window.localStorage.setItem('selectedProject', proj);
      window.localStorage.setItem('selectedAreaPath', proj);
    }, E2E_PROJECT);
  });

  test('Workflow 1: Planning renders only Roadmap and Releases tabs and redirects legacy /planning/dev-stats URL', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await stubAdoWorkItems(page);
    await stubReleaseAdoEndpoints(page, []);
    await loginAsPersona('ba');

    const planning = new PlanningReleasesPage(page);
    await planning.gotoPlanningRoot();

    // Only Roadmap and Releases appear; legacy tabs are completely absent
    await expect(planning.roadmapTabButton()).toBeVisible();
    await expect(planning.releasesTabButton()).toBeVisible();
    await expect(planning.planningTabsBar().getByRole('button', { name: 'Developer Stats' })).toHaveCount(0);
    await expect(planning.planningTabsBar().getByRole('button', { name: 'QA Metrics' })).toHaveCount(0);
    await expect(planning.planningTabsBar().getByRole('button', { name: 'AI Analysis' })).toHaveCount(0);

    // Navigating to legacy /planning/dev-stats redirects cleanly to /planning/roadmap
    await page.goto('/planning/dev-stats');
    await planning.waitForPlanningTabs();
    await expect(page).toHaveURL(/\/planning\/(roadmap|releases)/);
    await expect(planning.roadmapTabButton()).toHaveClass(/active/);
  });

  test('Workflow 2: Configure Desktop & Mobile platforms, review Slated Overview & QA validation, tag item platform, and move item across releases', async ({
    page,
    loginAsPersona,
  }) => {
    const epicsState: StubReleaseEpic[] = [
      {
        id: 701,
        version: '2026.11 Core Release',
        status: 'In Progress',
        startDate: '2026-11-01',
        targetDate: '2026-11-28',
        description: 'Desktop shell and Mobile sync improvements',
        items: [
          {
            id: 9001,
            title: 'Desktop Installer Signing',
            state: 'Ready For Release',
            workItemType: 'Feature',
            assignedTo: 'Alex Dev',
            tags: 'Desktop',
          },
          {
            id: 9002,
            title: 'Shared Session Renewal',
            state: 'Done',
            workItemType: 'Product Backlog Item',
            assignedTo: 'Sam Eng',
            tags: 'Desktop; Mobile',
          },
          {
            id: 9003,
            title: 'Mobile Push Deep-Link',
            state: 'UAT - Ready For Test',
            workItemType: 'Product Backlog Item',
            assignedTo: 'Jamie QA',
            tags: 'Mobile',
          },
          {
            id: 9004,
            title: 'Offline Retry Telemetry',
            state: 'In Progress',
            workItemType: 'Bug',
            assignedTo: 'Taylor Dev',
            tags: '',
          },
        ],
      },
      {
        id: 702,
        version: '2026.12 Mobile Patch',
        status: 'New',
        startDate: '2026-12-01',
        targetDate: '2026-12-15',
        description: 'Upcoming Mobile patch release',
        items: [
          {
            id: 9005,
            title: 'Biometric Login Prompt',
            state: 'UAT - Ready For Test',
            workItemType: 'Product Backlog Item',
            assignedTo: 'Jamie QA',
            tags: 'Mobile',
          },
        ],
      },
      {
        id: 703,
        version: '2026.10 Autumn Release',
        status: 'Done',
        startDate: '2026-10-01',
        targetDate: '2026-10-20',
        description: 'Already shipped release',
        items: [
          {
            id: 9006,
            title: 'Legacy Audit Export',
            state: 'Closed',
            workItemType: 'Feature',
            assignedTo: 'Alex Dev',
            tags: 'Desktop',
          },
        ],
      },
    ];

    await stubAdoProjects(page);
    await stubAdoWorkItems(page);
    await stubReleaseAdoEndpoints(page, epicsState);
    await loginAsPersona('ba');

    // Clean any preexisting MaxView platforms as authenticated BA session
    const prePlatformsRes = await page.request.get(
      `http://127.0.0.1:3000/api/releases/platforms?project=${E2E_PROJECT}`,
    );
    if (prePlatformsRes.ok()) {
      const preBody = (await prePlatformsRes.json()) as { platforms?: Array<{ id: string }> };
      for (const p of preBody.platforms ?? []) {
        const delRes = await page.request.delete(
          `http://127.0.0.1:3000/api/releases/platforms/${p.id}?project=${E2E_PROJECT}`,
        );
        expect(delRes.ok()).toBe(true);
      }
    }

    const planning = new PlanningReleasesPage(page);
    await planning.gotoReleases();

    // Verify initial Slated Overview before platforms are configured
    await expect(planning.slatedOverview()).toBeVisible();
    await expect(page.getByTestId('slated-releases-count')).toContainText('2');
    await expect(page.getByTestId('slated-overall-progress')).toContainText('40%'); // 2 green / 5 slated items
    await expect(page.getByTestId('slated-left-to-validate')).toContainText('3');
    await expect(planning.platformMatrix()).toHaveCount(0);

    // Configure target platforms (Desktop & Mobile) via Manage Platforms modal
    await planning.openManagePlatformsModal();
    await planning.addPresetPlatform('desktop');
    await planning.addPresetPlatform('mobile');
    await planning.closePlatformsModal();

    // Verify Platform Readiness Matrix renders accurate completion % & left-to-validate counts
    await expect(planning.platformMatrix()).toBeVisible();
    await expect(page.getByTestId('slated-platform-chip-desktop')).toContainText('100%');
    await expect(page.getByTestId('slated-platform-chip-desktop')).toContainText('0 left to validate');
    await expect(page.getByTestId('slated-platform-chip-mobile')).toContainText('33%');
    await expect(page.getByTestId('slated-platform-chip-mobile')).toContainText('2 left to validate');

    // Filter releases to Slated + Mobile platform
    await planning.selectLifecycleFilter('slated');
    await expect(page.getByTestId('release-rename-703')).toHaveCount(0);
    await planning.selectPlatformFilter('mobile');
    await expect(page.getByTestId('release-rename-701')).toBeVisible();
    await expect(page.getByTestId('release-rename-702')).toBeVisible();

    // Clear platform filter back to All Platforms so both slated releases stay visible
    await planning.selectPlatformFilter('all');

    // Expand 2026.11 Core Release and exercise QA validation filters & item grouping
    await planning.expandReleaseRow(701);
    await expect(page.getByText('Desktop Installer Signing')).toBeVisible();
    await expect(page.getByText('Mobile Push Deep-Link')).toBeVisible();

    await planning.filterExpandedItems(701, 'uat-ready');
    await expect(page.getByText('Mobile Push Deep-Link')).toBeVisible();
    await expect(page.getByText('Desktop Installer Signing')).toHaveCount(0);

    await planning.filterExpandedItems(701, 'left-to-validate');
    await expect(page.getByText('Mobile Push Deep-Link')).toBeVisible();
    await expect(page.getByText('Offline Retry Telemetry')).toBeVisible();

    // Reset item filter to All and switch grouping to Validation Status, then Platform
    await planning.filterExpandedItems(701, 'all');
    await planning.groupExpandedItemsBy(701, 'validation');
    await expect(page.getByTestId('release-item-section-701-amber')).toBeVisible();
    await expect(page.getByTestId('release-item-section-701-red')).toBeVisible();
    await expect(page.getByTestId('release-item-section-701-green')).toBeVisible();

    await planning.groupExpandedItemsBy(701, 'platform');
    await expect(page.getByTestId('release-item-section-701-desktop')).toBeVisible();
    await expect(page.getByTestId('release-item-section-701-mobile')).toBeVisible();
    await expect(page.getByTestId('release-item-section-701-unassigned')).toBeVisible();

    // Tag unassigned item #9004 with Desktop platform and verify readiness updates immediately
    await planning.assignPlatformToWorkItem(701, 9004, 'desktop');
    await expect(page.getByTestId('release-item-section-701-unassigned')).toHaveCount(0);
    await expect(page.getByTestId('release-expanded-platform-701-desktop')).toContainText(
      'Desktop: 2/3 ready · 1 left',
    );
    await expect(page.getByTestId('slated-platform-chip-desktop')).toContainText('67%');
    await expect(page.getByTestId('slated-platform-chip-desktop')).toContainText(
      '1 left to validate',
    );

    // Return to All Cards view and drag-move #9003 (UAT Ready) from 2026.11 Core Release (701) to 2026.12 Mobile Patch (702)
    await planning.groupExpandedItemsBy(701, 'none');
    await planning.dragWorkItemToRelease(701, 9003, 702);

    await expect(page.getByText('#9003 moved to 2026.12 Mobile Patch.')).toBeVisible();
    // 2026.11 Core Release now has 2 green + 1 red = 3 total -> 67% and "1 left"
    await expect(page.getByTestId('release-remaining-badge-701')).toContainText('1 left');
    // 2026.12 Mobile Patch now has 2 amber items -> 0% and "2 left" / "2 UAT ready"
    await expect(page.getByTestId('release-remaining-badge-702')).toContainText('2 left');
    await expect(page.getByTestId('release-remaining-badge-702')).toContainText('2 UAT ready');
  });
});
