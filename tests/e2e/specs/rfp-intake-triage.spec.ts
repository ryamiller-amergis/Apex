import { test, expect } from '../support/fixtures';
import { stubAdoProjects, suppressBetaAnnouncement } from '../support/api-stubs';
import type { EvaluateFlagsResponse } from '../../../src/shared/types/featureFlags';

async function stubRfpIntakeFlag(page: import('@playwright/test').Page, enabled: boolean): Promise<void> {
  await page.route('**/api/feature-flags/evaluate*', async (route) => {
    try {
      const response = await route.fetch();
      const data = (await response.json()) as EvaluateFlagsResponse;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ flags: { ...(data?.flags ?? {}), 'rfp-intake': enabled, 'beta-to-prod-announcement': false } }),
      });
    } catch {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ flags: { 'rfp-intake': enabled, 'beta-to-prod-announcement': false } }),
      });
    }
  });
}

const DETAIL = {
  id: 'rfp-triage-1',
  ownerId: 'owner-1',
  title: 'Triage tracker',
  stakeholder: 'BA team',
  request: 'Need a tracker',
  problem: 'Fragmented intake',
  audience: 'internal',
  dataSensitivity: 'internal-only',
  existingSolution: 'none',
  status: 'evaluated',
  aiStatus: 'complete',
  clarificationUsed: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  currentEvaluation: {
    id: 'eval-1',
    rfpRequestId: 'rfp-triage-1',
    version: 1,
    verdict: 'build',
    confidence: 'high',
    buildBuyRentSummary: 'Build it in Apex.',
    rationale: 'High native benefit.',
  },
  comments: [],
  attachments: [],
  activity: [
    { id: 'evt-1', rfpRequestId: 'rfp-triage-1', eventType: 'submitted', actorId: 'owner-1', payload: null, createdAt: new Date().toISOString() },
  ],
  evaluations: [],
};

test.describe('RFP intake triage VT-05', () => {
  test('PBI-005 AC-0 opens the triage queue and records a decision', async ({ page, loginAsPersona }) => {
    test.setTimeout(120_000);
    await suppressBetaAnnouncement(page);
    await stubRfpIntakeFlag(page, true);
    await stubAdoProjects(page);

    await page.route('**/api/me/permissions*', async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch().catch(() => null);
      let body: Record<string, unknown> = { permissions: ['rfp-intake:view', 'rfp-intake:manage'], roles: ['admin'], groups: [], userId: 'user-1', isSuperAdmin: true };
      if (response?.ok) {
        body = { ...(await response.json() as Record<string, unknown>), permissions: ['rfp-intake:view', 'rfp-intake:manage'] };
      }
      if (url.searchParams.get('project') === 'Apex' || !url.searchParams.get('project')) {
        body.permissions = [...new Set([...(body.permissions as string[] ?? []), 'rfp-intake:view', 'rfp-intake:manage'])];
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    await page.route('**/api/rfp-intake/triage/requests**', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...DETAIL,
            status: 'in-review',
            activity: [
              ...DETAIL.activity,
              { id: 'evt-2', rfpRequestId: DETAIL.id, eventType: 'status-changed', actorId: 'user-1', payload: { to: 'in-review' }, createdAt: new Date().toISOString() },
            ],
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{
            id: DETAIL.id,
            ownerId: DETAIL.ownerId,
            title: DETAIL.title,
            stakeholder: DETAIL.stakeholder,
            status: DETAIL.status,
            aiStatus: DETAIL.aiStatus,
            currentVerdict: 'build',
            clarificationUsed: false,
            createdAt: DETAIL.createdAt,
            updatedAt: DETAIL.updatedAt,
          }],
          total: 1,
        }),
      });
    });

    await page.route('**/api/rfp-intake/triage/requests/rfp-triage-1', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DETAIL) });
    });

    await page.addInitScript(() => {
      window.localStorage.setItem('selectedProject', 'Apex');
    });
    await loginAsPersona('ba');
    await page.goto('/rfp-intake');
    await expect(page.getByTestId('rfp-queue-view')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('rfp-queue-search').fill('Triage');
    await expect(page.getByTestId('rfp-queue-row-rfp-triage-1')).toBeVisible();
    await page.getByTestId('rfp-queue-open-rfp-triage-1').click();
    await expect(page.getByTestId('rfp-triage-detail')).toBeVisible();
    await page.getByTestId('rfp-status-in-review').click();
    await expect(page.getByTestId('rfp-activity-trail')).toBeVisible();
  });

  test('PBI-006 AC-0 posts a comment with a mention from triage detail', async ({ page, loginAsPersona }) => {
    test.setTimeout(120_000);
    await suppressBetaAnnouncement(page);
    await stubRfpIntakeFlag(page, true);
    await stubAdoProjects(page);

    await page.route('**/api/rfp-intake/triage/requests**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{
            id: DETAIL.id,
            ownerId: DETAIL.ownerId,
            title: DETAIL.title,
            stakeholder: DETAIL.stakeholder,
            status: 'in-review',
            aiStatus: 'complete',
            currentVerdict: 'build',
            clarificationUsed: false,
            createdAt: DETAIL.createdAt,
            updatedAt: DETAIL.updatedAt,
          }],
          total: 1,
        }),
      });
    });
    await page.route('**/api/rfp-intake/triage/requests/rfp-triage-1', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...DETAIL, status: 'in-review' }) });
    });
    await page.route('**/api/rfp-intake/mentions/candidates**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ userId: 'owner-1', displayName: 'Owner', email: 'owner@example.com' }]),
      });
    });
    await page.route('**/api/rfp-intake/requests/rfp-triage-1/comments', async (route) => {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'c-1',
          rfpRequestId: DETAIL.id,
          authorId: 'user-1',
          body: 'Need a screenshot @Owner',
          mentionedUserIds: ['owner-1'],
          createdAt: new Date().toISOString(),
        }),
      });
    });

    await loginAsPersona('ba');
    await page.goto('/rfp-intake/rfp-triage-1');
    await expect(page.getByTestId('rfp-comment-composer')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('rfp-comment-input').fill('Need a screenshot @Ow');
    await expect(page.getByTestId('rfp-mention-picker')).toBeVisible();
    await page.getByTestId('rfp-mention-owner-1').click();
    await page.getByTestId('rfp-comment-submit').click();
    await expect(page.getByTestId('rfp-activity-trail')).toBeVisible();
  });

  test('PBI-006 AC-3 rejects an oversized attachment in the triage composer', async ({ page, loginAsPersona }) => {
    test.setTimeout(120_000);
    await suppressBetaAnnouncement(page);
    await stubRfpIntakeFlag(page, true);
    await stubAdoProjects(page);
    await page.route('**/api/rfp-intake/triage/requests**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{
            id: DETAIL.id,
            ownerId: DETAIL.ownerId,
            title: DETAIL.title,
            stakeholder: DETAIL.stakeholder,
            status: 'in-review',
            aiStatus: 'complete',
            currentVerdict: 'build',
            clarificationUsed: false,
            createdAt: DETAIL.createdAt,
            updatedAt: DETAIL.updatedAt,
          }],
          total: 1,
        }),
      });
    });
    await page.route('**/api/rfp-intake/triage/requests/rfp-triage-1', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...DETAIL, status: 'in-review' }) });
    });

    await loginAsPersona('ba');
    await page.goto('/rfp-intake/rfp-triage-1');
    await expect(page.getByTestId('rfp-attachment-input')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('rfp-attachment-input').setInputFiles({
      name: 'huge.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    await expect(page.getByRole('alert')).toContainText(/exceeds 10 MB/i);
  });
});
