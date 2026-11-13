import { test, expect, SeedApi, E2E_PROJECT } from '../support/fixtures';
import {
  stubAdoProjects,
  stubAdoWorkItems,
  suppressBetaAnnouncement,
  suppressSseStreams,
} from '../support/api-stubs';
import { DEFAULT_ENABLED_MENU_VIEWS } from '../../../src/shared/types/menuSettings';
import { deriveReleasePlatform } from '../../../src/shared/utils/releasePlatform';
import type { Page } from '@playwright/test';

test.use({
  video: 'on',
  viewport: { width: 1440, height: 900 },
});

interface MockEpic {
  id: number;
  version: string;
  status: string;
  areaPath: string;
  platform: string;
  startDate?: string;
  targetDate?: string;
  description?: string;
  progress: number;
  totalItems: number;
  completedItems: number;
  greenItems: number;
  amberItems: number;
  redItems: number;
}

interface MockWorkItem {
  id: number;
  title: string;
  state: string;
  workItemType: string;
  assignedTo?: string;
  targetDate?: string;
  tags: string;
  changedDate: string;
  createdDate: string;
  areaPath: string;
  iterationPath: string;
}

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function recomputeCounts(epic: MockEpic, items: MockWorkItem[]): MockEpic {
  const greenStates = new Set(['Ready For Release', 'UAT - Test Done', 'Done', 'Closed']);
  const amberStates = new Set(['UAT - Ready For Test', 'UAT Ready For Test', 'UAT-Ready For Test']);
  let greenItems = 0;
  let amberItems = 0;
  let redItems = 0;
  for (const item of items) {
    if (greenStates.has(item.state)) greenItems++;
    else if (amberStates.has(item.state)) amberItems++;
    else redItems++;
  }
  const totalItems = items.length;
  return {
    ...epic,
    totalItems,
    completedItems: greenItems,
    greenItems,
    amberItems,
    redItems,
    progress: totalItems > 0 ? Math.round((greenItems / totalItems) * 100) : 0,
  };
}

async function installReleaseStubs(page: Page) {
  const relatedMap = new Map<number, MockWorkItem[]>([
    [
      101,
      [
        {
          id: 501,
          title: 'Biometric Login Flow',
          state: 'In Progress',
          workItemType: 'Feature',
          assignedTo: 'Alex Rivera',
          tags: '',
          changedDate: '2026-11-05',
          createdDate: '2026-10-20',
          areaPath: 'MaxView\\Mobile',
          iterationPath: 'MaxView\\Sprint 10',
        },
        {
          id: 502,
          title: 'Push Token Refresh Crash',
          state: 'Blocked',
          workItemType: 'Bug',
          assignedTo: undefined,
          tags: '',
          changedDate: '2026-11-06',
          createdDate: '2026-10-22',
          areaPath: 'MaxView\\Mobile',
          iterationPath: 'MaxView\\Sprint 10',
        },
        {
          id: 503,
          title: 'Dark Mode Settings Screen',
          state: 'UAT - Ready For Test',
          workItemType: 'Product Backlog Item',
          assignedTo: 'Jordan Lee',
          tags: '',
          changedDate: '2026-11-07',
          createdDate: '2026-10-24',
          areaPath: 'MaxView\\Mobile',
          iterationPath: 'MaxView\\Sprint 10',
        },
        {
          id: 504,
          title: 'Keychain Secure Wrapper',
          state: 'Done',
          workItemType: 'Technical Backlog Item',
          assignedTo: 'Sam Patel',
          tags: '',
          changedDate: '2026-11-08',
          createdDate: '2026-10-25',
          areaPath: 'MaxView\\Mobile',
          iterationPath: 'MaxView\\Sprint 10',
        },
      ],
    ],
    [
      102,
      [
        {
          id: 601,
          title: 'Desktop Offline Sync Engine',
          state: 'In Progress',
          workItemType: 'Feature',
          assignedTo: 'Morgan Chen',
          tags: '',
          changedDate: '2026-11-04',
          createdDate: '2026-10-18',
          areaPath: 'MaxView\\Desktop',
          iterationPath: 'MaxView\\Sprint 10',
        },
      ],
    ],
    [
      103,
      [
        {
          id: 701,
          title: 'Legacy Export Patch',
          state: 'Done',
          workItemType: 'Product Backlog Item',
          assignedTo: 'Alex Rivera',
          tags: '',
          changedDate: '2026-10-10',
          createdDate: '2026-10-01',
          areaPath: 'MaxView\\Desktop',
          iterationPath: 'MaxView\\Sprint 8',
        },
      ],
    ],
  ]);

  let epics: MockEpic[] = [
    recomputeCounts(
      {
        id: 101,
        version: 'v2.4.0',
        status: 'In Progress',
        areaPath: 'MaxView\\Mobile',
        platform: 'Mobile',
        startDate: isoDaysFromNow(-10),
        targetDate: isoDaysFromNow(5),
        description: 'Mobile biometric release',
        progress: 0,
        totalItems: 0,
        completedItems: 0,
        greenItems: 0,
        amberItems: 0,
        redItems: 0,
      },
      relatedMap.get(101) ?? [],
    ),
    recomputeCounts(
      {
        id: 102,
        version: 'v3.1.0',
        status: 'New',
        areaPath: 'MaxView\\Desktop',
        platform: 'Desktop',
        startDate: isoDaysFromNow(-5),
        targetDate: isoDaysFromNow(-2),
        description: 'Desktop offline queue release',
        progress: 0,
        totalItems: 0,
        completedItems: 0,
        greenItems: 0,
        amberItems: 0,
        redItems: 0,
      },
      relatedMap.get(102) ?? [],
    ),
    recomputeCounts(
      {
        id: 103,
        version: 'v3.0.0',
        status: 'Done',
        areaPath: 'MaxView\\Desktop',
        platform: 'Desktop',
        startDate: isoDaysFromNow(-40),
        targetDate: isoDaysFromNow(-20),
        description: 'Shipped desktop release',
        progress: 0,
        totalItems: 0,
        completedItems: 0,
        greenItems: 0,
        amberItems: 0,
        redItems: 0,
      },
      relatedMap.get(103) ?? [],
    ),
  ];

  const nestedFeatureChildren: Record<number, MockWorkItem[]> = {
    501: [
      {
        id: 5011,
        title: 'FaceID Prompt Hook',
        state: 'UAT - Ready For Test',
        workItemType: 'Product Backlog Item',
        assignedTo: 'Alex Rivera',
        tags: '',
        changedDate: '2026-11-06',
        createdDate: '2026-10-21',
        areaPath: 'MaxView\\Mobile',
        iterationPath: 'MaxView\\Sprint 10',
      },
    ],
  };

  const outcomesByVersion: Record<string, Array<{
    id: string;
    deploymentId: string;
    releaseVersion: string;
    result: 'success' | 'downtime' | 'rollback';
    reportedBy: string;
    reportedAt: string;
    details?: string;
  }>> = {
    'v3.0.0': [
      {
        id: 'out-300',
        deploymentId: 'dep-300',
        releaseVersion: 'v3.0.0',
        result: 'success',
        reportedBy: 'E2E BA',
        reportedAt: '2026-10-25T12:00:00.000Z',
        details: 'Clean deploy',
      },
    ],
  };

  let nextEpicId = 200;
  let lastOrderPayload: number[] | null = null;

  await page.route('**/api/projects/*/area-paths*', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(['MaxView', 'MaxView\\Mobile', 'MaxView\\Desktop', 'MaxView\\Platform']),
    });
  });

  await page.route('**/api/releases/epics*', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(epics),
    });
  });

  await page.route('**/api/releases?*', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(epics.map((e) => e.version)),
    });
  });

  await page.route('**/api/releases/order*', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { epicIds?: number[] };
      if (Array.isArray(body?.epicIds)) {
        lastOrderPayload = body.epicIds;
        const byId = new Map(epics.map((e) => [e.id, e]));
        epics = body.epicIds.map((id) => byId.get(id)).filter((e): e is MockEpic => Boolean(e));
      }
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, count: epics.length }),
      });
    } else {
      void route.continue();
    }
  });

  await page.route('**/api/releases/*/related-items*', (route) => {
    const match = /\/api\/releases\/(\d+)\/related-items/.exec(route.request().url());
    const epicId = match ? Number(match[1]) : 0;
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(relatedMap.get(epicId) ?? []),
    });
  });

  await page.route('**/api/features/*/children*', (route) => {
    const match = /\/api\/features\/(\d+)\/children/.exec(route.request().url());
    const featureId = match ? Number(match[1]) : 0;
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(nestedFeatureChildren[featureId] ?? []),
    });
  });

  await page.route('**/api/epics/*/children*', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  await page.route('**/api/releases/*/link-related*', (route) => {
    const match = /\/api\/releases\/(\d+)\/link-related/.exec(route.request().url());
    const targetEpicId = match ? Number(match[1]) : 0;
    const body = route.request().postDataJSON() as { workItemIds?: number[] };
    const workItemIds = body?.workItemIds ?? [];
    const movedItems: MockWorkItem[] = [];

    for (const [sourceId, list] of relatedMap.entries()) {
      const remaining: MockWorkItem[] = [];
      for (const item of list) {
        if (workItemIds.includes(item.id) && sourceId !== targetEpicId) {
          movedItems.push(item);
        } else {
          remaining.push(item);
        }
      }
      relatedMap.set(sourceId, remaining);
    }

    const targetList = relatedMap.get(targetEpicId) ?? [];
    for (const moved of movedItems) {
      if (!targetList.some((item) => item.id === moved.id)) {
        targetList.push(moved);
      }
    }
    relatedMap.set(targetEpicId, targetList);
    epics = epics.map((epic) => recomputeCounts(epic, relatedMap.get(epic.id) ?? []));

    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        linkedCount: movedItems.length,
        movedCount: movedItems.length,
        unchangedCount: 0,
        movedFrom: {},
      }),
    });
  });

  await page.route('**/api/releases/*/unlink-related*', (route) => {
    const match = /\/api\/releases\/(\d+)\/unlink-related/.exec(route.request().url());
    const epicId = match ? Number(match[1]) : 0;
    const body = route.request().postDataJSON() as { workItemIds?: number[] };
    const removeIds = new Set(body?.workItemIds ?? []);
    const remaining = (relatedMap.get(epicId) ?? []).filter((item) => !removeIds.has(item.id));
    relatedMap.set(epicId, remaining);
    epics = epics.map((epic) => recomputeCounts(epic, relatedMap.get(epic.id) ?? []));

    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, unlinkedCount: removeIds.size }),
    });
  });

  await page.route('**/api/releases/*/rename*', (route) => {
    const match = /\/api\/releases\/(\d+)\/rename/.exec(route.request().url());
    const epicId = match ? Number(match[1]) : 0;
    const body = route.request().postDataJSON() as { newName?: string };
    const newName = (body?.newName ?? '').trim();
    const duplicate = epics.some((e) => e.id !== epicId && e.version.toLowerCase() === newName.toLowerCase());
    if (duplicate) {
      void route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: `A release named "${newName}" already exists` }),
      });
      return;
    }

    const oldName = epics.find((e) => e.id === epicId)?.version ?? '';
    epics = epics.map((e) => (e.id === epicId ? { ...e, version: newName } : e));
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, oldName, newName }),
    });
  });

  await page.route('**/api/releases/*/tag*', (route) => {
    const match = /\/api\/releases\/([^/]+)\/tag/.exec(route.request().url());
    const version = match ? decodeURIComponent(match[1]) : 'v0.0.0';
    const body = route.request().postDataJSON() as {
      areaPath?: string;
      startDate?: string;
      targetDate?: string;
      description?: string;
    };
    const epicId = nextEpicId++;
    const chosenArea = body?.areaPath || 'MaxView';
    const created: MockEpic = {
      id: epicId,
      version,
      status: 'New',
      areaPath: chosenArea,
      platform: deriveReleasePlatform(chosenArea, 'MaxView'),
      startDate: body?.startDate,
      targetDate: body?.targetDate,
      description: body?.description,
      progress: 0,
      totalItems: 0,
      completedItems: 0,
      greenItems: 0,
      amberItems: 0,
      redItems: 0,
    };
    relatedMap.set(epicId, []);
    epics = [created, ...epics];
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, epicId, taggedCount: 0 }),
    });
  });

  await page.route('**/api/deployments/*/latest*', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });

  await page.route('**/api/deployment-outcomes/by-release/*', (route) => {
    const version = decodeURIComponent(route.request().url().split('/by-release/')[1]?.split('?')[0] ?? '');
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(outcomesByVersion[version] ?? []),
    });
  });

  await page.route('**/api/deployment-outcomes*', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  return {
    getLastOrderPayload: () => lastOrderPayload,
  };
}

test.describe('Planning -> Releases Redesign', () => {
  test.beforeEach(async ({ page, e2eApi }) => {
    await suppressSseStreams(page);
    await suppressBetaAnnouncement(page);
    await stubAdoProjects(page);
    await stubAdoWorkItems(page, []);
    await SeedApi.setMenuSettings(e2eApi, E2E_PROJECT, DEFAULT_ENABLED_MENU_VIEWS);
    await page.addInitScript(() => {
      localStorage.setItem('selectedProject', 'MaxView');
      localStorage.setItem('selectedAreaPath', 'MaxView');
    });
  });

  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('renders two-pane workspace, platform/scope/search/sort controls, readiness gap pills, and tabs', async ({
    page,
    loginAsPersona,
  }) => {
    await installReleaseStubs(page);
    await loginAsPersona('ba');
    await page.goto('/planning/releases');

    await expect(page.getByTestId('release-workspace')).toBeVisible({ timeout: 15_000 });

    // Default Active & Upcoming shows v2.4.0 (Mobile) and v3.1.0 (Desktop), hides Shipped v3.0.0
    await expect(page.getByTestId('release-card-101')).toBeVisible();
    await expect(page.getByTestId('release-card-102')).toBeVisible();
    await expect(page.getByTestId('release-card-103')).toHaveCount(0);

    // Platform badges, countdowns, and remaining chips
    await expect(page.getByTestId('release-platform-badge-101')).toHaveText('Mobile');
    await expect(page.getByTestId('release-platform-badge-102')).toHaveText('Desktop');
    await expect(page.getByTestId('release-card-countdown-101')).toContainText('5d left');
    await expect(page.getByTestId('release-card-countdown-102')).toContainText('Overdue');
    await expect(page.getByTestId('release-card-remaining-101')).toHaveText('2 Dev · 1 UAT');

    // Inspector shows v2.4.0 readiness summary counters and clickable gap pills
    await expect(page.getByTestId('readiness-count-ready')).toHaveText('1');
    await expect(page.getByTestId('readiness-count-uat')).toHaveText('1');
    await expect(page.getByTestId('readiness-count-not-ready')).toHaveText('2');

    await expect(page.getByTestId('gap-pill-dev')).toHaveText('2 items still in Dev');
    await expect(page.getByTestId('gap-pill-uat')).toHaveText('1 awaiting UAT');
    await expect(page.getByTestId('gap-pill-unassigned')).toHaveText('1 unassigned');

    // Default tab is Needs Attention (501, 502, 503 visible; Done item 504 hidden)
    await expect(page.getByTestId('release-item-101-502')).toBeVisible();
    await expect(page.getByTestId('release-item-101-501')).toBeVisible();
    await expect(page.getByTestId('release-item-101-503')).toBeVisible();
    await expect(page.getByTestId('release-item-101-504')).toHaveCount(0);

    // Click unassigned gap pill -> filters to #502 only
    await page.getByTestId('gap-pill-unassigned').click();
    await expect(page.getByTestId('release-item-101-502')).toBeVisible();
    await expect(page.getByTestId('release-item-101-501')).toHaveCount(0);
    await page.getByTestId('gap-filter-reset').click();

    // Switch to Ready / Done and All Items tabs
    await page.getByTestId('release-tab-ready').click();
    await expect(page.getByTestId('release-item-101-504')).toBeVisible();
    await page.getByTestId('release-tab-all').click();
    await expect(page.getByTestId('release-item-101-501')).toBeVisible();
    await expect(page.getByTestId('release-item-101-504')).toBeVisible();

    // Platform filter, Lifecycle scope filter, Search & Sort
    await page.getByTestId('release-platform-filter-desktop').click();
    await expect(page.getByTestId('release-card-101')).toHaveCount(0);
    await expect(page.getByTestId('release-card-102')).toBeVisible();

    await page.getByTestId('release-platform-filter-all').click();
    await page.getByTestId('release-scope-filter-shipped').click();
    await expect(page.getByTestId('release-card-103')).toBeVisible();
    await expect(page.getByTestId('release-card-101')).toHaveCount(0);

    await page.getByTestId('release-scope-filter-all').click();
    await page.getByTestId('release-sort-select').selectOption('version');
    await page.getByTestId('release-search-input').fill('offline');
    await expect(page.getByTestId('release-card-102')).toBeVisible();
    await expect(page.getByTestId('release-card-101')).toHaveCount(0);
  });

  test('supports nested expansion, drag-to-move work item, unlink, inline rename, reorder, and area-path-aware creation', async ({
    page,
    loginAsPersona,
  }) => {
    const tracker = await installReleaseStubs(page);
    await loginAsPersona('ba');
    await page.goto('/planning/releases');

    await expect(page.getByTestId('release-item-101-501')).toBeVisible({ timeout: 15_000 });

    // Nested Feature expansion
    await page.getByTestId('release-item-expand-101-501').click();
    await expect(page.getByTestId('release-nested-item-5011')).toBeVisible();

    // Drag-to-move work item #503 from v2.4.0 (101) to v3.1.0 (102)
    await page.getByTestId('release-item-101-503').dragTo(page.getByTestId('release-card-102'));
    await expect(page.getByText('#503 moved to v3.1.0.')).toBeVisible();
    await expect(page.getByTestId('release-item-101-503')).toHaveCount(0);

    // Unlink #502 from v2.4.0
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByTestId('release-item-unlink-101-502').click();
    await expect(page.getByTestId('release-item-101-502')).toHaveCount(0);

    // Manual Order drag-to-reorder (102 -> 101)
    const handleBox = await page.getByTestId('release-drag-handle-102').boundingBox();
    const targetCardBox = await page.getByTestId('release-card-101').boundingBox();
    expect(handleBox).not.toBeNull();
    expect(targetCardBox).not.toBeNull();
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      targetCardBox!.x + targetCardBox!.width / 2,
      targetCardBox!.y + targetCardBox!.height / 2,
      { steps: 10 },
    );
    await page.mouse.up();
    await expect.poll(() => tracker.getLastOrderPayload()).toEqual([102, 101, 103]);

    // Inline rename: 409 duplicate error then valid rename
    await page.getByTestId('release-card-101').click();
    await page.getByTestId('release-rename-101').click();
    const renameInput = page.getByTestId('release-rename-input-101');
    await renameInput.fill('v3.1.0');
    await renameInput.press('Enter');
    await expect(page.getByTestId('release-rename-error-101')).toContainText('already exists');

    await renameInput.fill('v2.4.1');
    await renameInput.press('Enter');
    await expect(page.getByTestId('release-card-version-101')).toHaveText('v2.4.1');

    // Area-path-aware New Release creation (choose MaxView\Mobile from parent area path)
    await page.getByTestId('release-create').click();
    await expect(page.getByTestId('release-form-modal')).toBeVisible();
    await page.getByTestId('release-form-area-path').selectOption('MaxView\\Mobile');
    await page.getByTestId('release-form-name').fill('v2.5.0');
    await page.getByTestId('release-form-start-date').fill('2026-11-15');
    await page.getByTestId('release-form-target-date').fill('2026-11-30');
    await page.getByTestId('release-form-description').fill('Next mobile sprint');
    await page.getByTestId('release-form-save').click();

    await expect(page.getByTestId('release-form-modal')).toHaveCount(0);
    await expect(page.getByTestId('release-card-version-200')).toHaveText('v2.5.0');
    await expect(page.getByTestId('release-platform-badge-200')).toHaveText('Mobile');
  });
});
