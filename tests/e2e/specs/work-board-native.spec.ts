/**
 * Work Board — native source-of-truth rollout (project-scoped RBAC + releases).
 *
 * Stubs board APIs + menu/permissions so the UI can be exercised without a
 * fully provisioned board project in the e2e DB.
 *
 * Lower-tier substitutes (unit/integration):
 * - src/client/components/__tests__/ApexWorkBoardView.test.tsx
 * - src/client/hooks/__tests__/useApexWorkItems.test.ts
 * - src/server/__tests__/apexWorkItemsRoutes.test.ts
 */
import { test, expect } from '../support/fixtures';
import { suppressSseStreams, suppressBetaAnnouncement } from '../support/api-stubs';

const SAMPLE_ITEMS = [
  {
    id: 'e2e-pbi-1',
    project: 'Apex',
    itemNumber: 12,
    title: 'E2E Prioritize feature requests',
    outcome: 'As a BA\nI want priority\nSo that grooming is clear',
    type: 'PBI',
    status: 'ready',
    owner: { oid: 'u1', displayName: 'E2E User', email: 'e2e@example.com' },
    collaborators: [],
    acceptanceCriteria: [{ id: 'ac1', text: 'Given: x\nWhen: y\nThen: z', done: false }],
    branch: null,
    prUrl: null,
    position: 0,
    dueDate: null,
    releaseId: 'rel-1',
    release: {
      id: 'rel-1',
      project: 'Apex',
      name: 'R5',
      version: null,
      targetDate: null,
      status: 'active',
      position: 0,
      createdBy: 'u1',
      updatedBy: 'u1',
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-01T00:00:00Z',
    },
    parentId: null,
    sourceType: 'feature_request',
    prdId: null,
    backlogItemId: null,
    featureRequestId: 'fr-1',
    adoWorkItemId: null,
    epicId: null,
    epicTitle: 'Intake',
    featureId: null,
    featureTitle: 'Triage',
    createdBy: 'u1',
    updatedBy: 'u1',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
  },
];

async function stubWorkBoardApis(page: import('@playwright/test').Page) {
  await page.route('**/api/me/permissions**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        permissions: [
          'work-board:view',
          'work-board:manage',
          'work-board:admin',
          'planning:view',
          'planning:roadmap',
          'home:view',
        ],
      }),
    });
  });

  await page.route('**/api/menu-config**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        enabledViews: ['work-board', 'planning', 'home', 'feature-requests', 'backlog'],
      }),
    });
  });

  await page.route('**/api/apex-work-items/stream**', async (route) => {
    await route.fulfill({ status: 200, body: '' });
  });

  await page.route('**/api/apex-work-items/owners**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ oid: 'u1', displayName: 'E2E User', email: 'e2e@example.com' }]),
    });
  });

  await page.route('**/api/apex-work-items/facets**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        epicTitles: ['Intake'],
        featureTitles: ['Triage'],
        owners: [{ oid: 'u1', displayName: 'E2E User', email: 'e2e@example.com' }],
        releases: [{ id: 'rel-1', name: 'R5', project: 'Apex' }],
      }),
    });
  });

  await page.route('**/api/apex-work-items/releases**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'rel-1',
          project: 'Apex',
          name: 'R5',
          version: null,
          targetDate: '2026-09-01',
          status: 'active',
          position: 0,
          itemCount: 1,
          doneCount: 0,
          createdBy: 'u1',
          updatedBy: 'u1',
          createdAt: '2026-08-01T00:00:00Z',
          updatedAt: '2026-08-01T00:00:00Z',
        },
      ]),
    });
  });

  await page.route('**/api/apex-work-items?**', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SAMPLE_ITEMS),
    });
  });

  await page.route('**/api/apex-work-items/', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const url = route.request().url();
    if (url.includes('/attachments') || url.includes('/comments') || url.includes('/move')) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SAMPLE_ITEMS),
    });
  });
}

test.describe('Work Board native rollout @work-board', () => {
  test.beforeEach(async ({ page }) => {
    await suppressSseStreams(page);
    await suppressBetaAnnouncement(page);
    await stubWorkBoardApis(page);
  });

  test('board view loads with columns when user has work-board:view', async ({ page, loginAsPersona }) => {
    await loginAsPersona('developer');
    await page.goto('/work-board');
    await expect(page.getByTestId('work-board-view')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('work-board-view-board')).toBeVisible();
    await expect(page.getByText('Idea')).toBeVisible();
    await expect(page.getByText('Ready')).toBeVisible();
    await expect(page.getByText('E2E Prioritize feature requests')).toBeVisible();
  });

  test('release lens toggle regroups board', async ({ page, loginAsPersona }) => {
    await loginAsPersona('developer');
    await page.goto('/work-board');
    await expect(page.getByTestId('work-board-lens-release')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('work-board-lens-release').click();
    await expect(page.getByTestId('work-board-release-lanes')).toBeVisible();
  });

  test('backlog toggle switches to list view', async ({ page, loginAsPersona }) => {
    await loginAsPersona('developer');
    await page.goto('/work-board');
    await expect(page.getByTestId('work-board-view-backlog')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('work-board-view-backlog').click();
    await expect(page.getByTestId('work-board-backlog')).toBeVisible();
  });

  test('detail drawer shows hierarchy and attachment open link', async ({ page, loginAsPersona }) => {
    await page.route('**/api/apex-work-items/e2e-pbi-1?**', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...SAMPLE_ITEMS[0],
          parent: null,
          children: [],
          comments: [],
          attachments: [
            {
              id: 'att-1',
              workItemId: 'e2e-pbi-1',
              project: 'Apex',
              fileName: 'spec.pdf',
              contentType: 'application/pdf',
              byteSize: 12,
              storagePath: 'https://example.com/spec.pdf',
              openUrl: 'https://example.com/spec.pdf',
              uploadedBy: { oid: 'u1', displayName: 'E2E User', email: 'e2e@example.com' },
              createdAt: '2026-08-01T00:00:00Z',
            },
          ],
          events: [],
        }),
      });
    });
    await page.route('**/api/apex-work-items/e2e-pbi-1/attachments?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'att-1',
            workItemId: 'e2e-pbi-1',
            project: 'Apex',
            fileName: 'spec.pdf',
            contentType: 'application/pdf',
            byteSize: 12,
            storagePath: 'https://example.com/spec.pdf',
            openUrl: 'https://example.com/spec.pdf',
            uploadedBy: { oid: 'u1', displayName: 'E2E User', email: 'e2e@example.com' },
            createdAt: '2026-08-01T00:00:00Z',
          },
        ]),
      });
    });

    await loginAsPersona('developer');
    await page.goto('/work-board?item=e2e-pbi-1');
    await expect(page.getByTestId('work-item-hierarchy')).toBeVisible({ timeout: 15_000 });
    const link = page.getByTestId('work-item-attachment-link-att-1');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('href', 'https://example.com/spec.pdf');
  });
});
