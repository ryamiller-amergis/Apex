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
  expectedUsers: 'medium',
  aiInApp: 'no',
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
  reviewerDecision: null,
  architecture: null,
  reviewSubmittedAt: null,
  reviewSubmittedBy: null,
  proposalGeneration: null,
  proposalDraft: null,
  proposal: null,
  approval: null,
  comments: [],
  attachments: [],
  activity: [
    { id: 'evt-1', rfpRequestId: 'rfp-triage-1', eventType: 'submitted', actorId: 'owner-1', payload: null, createdAt: new Date().toISOString() },
  ],
  evaluations: [],
};

const GENERATED_AT = new Date().toISOString();

const PROPOSAL_DRAFT = {
  version: 1,
  kind: 'proposal',
  jobId: 'job-1',
  inputFingerprint: 'fp-1',
  verdict: 'build',
  generatedAt: GENERATED_AT,
  editedBy: null,
  editedAt: null,
  sections: {
    executiveSummary: 'Build a triage tracker in Apex.',
    recommendedSolution: 'A small console app.',
    scope: ['Intake queue'],
    deliveryPhases: [{ name: 'Build', duration: '4 weeks', outcomes: ['Working queue'] }],
    timeline: 'About six weeks.',
    assumptions: ['Two environments'],
    exclusions: ['Mobile app'],
    risks: [{ risk: 'Low adoption', mitigation: 'Pilot with one team' }],
    securityAndData: 'Internal data only.',
    ownership: 'BA team owns it.',
    nextSteps: ['Approve the proposal'],
  },
  costLines: [
    {
      id: 'rds-prod',
      label: 'Production database',
      category: 'operating',
      cadence: 'monthly',
      quantity: 730,
      unit: 'instance-hour',
      unitPrice: 0.16,
      amounts: { low: 100, expected: 120, high: 140 },
      currency: 'USD',
      priceStatus: 'verified',
      sourceType: 'aws-price-list',
      sourceUrl: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/us-east-1/index.json',
      sourceTitle: 'AWS Price List — Amazon RDS',
      retrievedAt: GENERATED_AT,
      confidence: 'high',
      assumptions: [],
      adminConfirmed: false,
    },
    {
      id: 'implementation-1',
      label: 'Build and launch',
      category: 'implementation',
      cadence: 'one-time',
      quantity: 6,
      unit: 'person-week',
      unitPrice: null,
      amounts: null,
      currency: 'USD',
      priceStatus: 'estimate',
      sourceType: 'internal-estimate',
      sourceUrl: null,
      sourceTitle: null,
      retrievedAt: null,
      confidence: 'medium',
      assumptions: ['Effort estimate: 4–8 person-weeks (expected 6).'],
      adminConfirmed: false,
    },
  ],
  totals: {
    oneTime: { low: 0, expected: 0, high: 0 },
    monthly: { low: 100, expected: 120, high: 140 },
    annual: { low: 1200, expected: 1440, high: 1680 },
    unpricedLineCount: 1,
  },
};

function generationState(status: string) {
  return {
    jobId: 'job-1',
    kind: 'proposal',
    status,
    attempts: 1,
    maxAttempts: 3,
    errorMessage: null,
    queuedAt: GENERATED_AT,
    startedAt: GENERATED_AT,
    completedAt: status === 'ready' ? GENERATED_AT : null,
  };
}

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
    await expect(page.getByTestId('rfp-wizard')).toBeVisible();
    await page.getByTestId('rfp-wizard-step-2').click();
    await page.getByTestId('rfp-status-in-review').click();
    await expect(page.getByTestId('rfp-activity-list')).toBeVisible();
  });

  test('SR-0 PB-0 submits the review, waits for generation, and publishes the proposal', async ({ page, loginAsPersona }) => {
    test.setTimeout(120_000);
    await suppressBetaAnnouncement(page);
    await stubRfpIntakeFlag(page, true);
    await stubAdoProjects(page);

    const architecture = {
      appType: 'console',
      resources: ['rds'],
      requiresAi: false,
      domainName: null,
      sizing: {
        region: 'us-east',
        sizingProfile: 'medium',
        environmentCount: 2,
        uptimePattern: 'always-on',
        storageGb: 100,
        aiUsage: null,
      },
      updatedBy: 'user-1',
      updatedAt: GENERATED_AT,
    };
    let phase: 'review' | 'generating' | 'ready' | 'published' = 'review';
    let detailReads = 0;
    const submitBodies: unknown[] = [];
    const publishBodies: unknown[] = [];

    const currentDetail = () => {
      if (phase === 'review') return { ...DETAIL, status: 'in-review' };
      const submitted = { ...DETAIL, status: 'in-review', architecture, reviewSubmittedAt: GENERATED_AT, reviewSubmittedBy: 'user-1' };
      if (phase === 'generating') return { ...submitted, proposalGeneration: generationState('researching-prices') };
      const ready = { ...submitted, proposalGeneration: generationState('ready'), proposalDraft: PROPOSAL_DRAFT };
      if (phase === 'ready') return ready;
      return {
        ...ready,
        proposal: {
          document: PROPOSAL_DRAFT,
          productOwnerId: 'owner-1',
          productOwnerName: 'Owner',
          publishedBy: 'user-1',
          publishedAt: new Date().toISOString(),
        },
      };
    };

    await page.route('**/api/me/permissions*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ permissions: ['rfp-intake:view', 'rfp-intake:manage'], roles: ['admin'], groups: [], userId: 'user-1', isSuperAdmin: true }),
      });
    });
    await page.route('**/api/rfp-intake/triage/requests**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], total: 0 }),
      });
    });
    await page.route('**/api/rfp-intake/triage/requests/rfp-triage-1', async (route) => {
      if (phase === 'generating') {
        detailReads += 1;
        if (detailReads > 1) phase = 'ready';
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(currentDetail()) });
    });
    await page.route('**/api/rfp-intake/triage/requests/rfp-triage-1/submit-review', async (route) => {
      submitBodies.push(route.request().postDataJSON());
      phase = 'generating';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(currentDetail()) });
    });
    await page.route('**/api/rfp-intake/triage/requests/rfp-triage-1/proposal-draft', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(currentDetail()) });
    });
    await page.route('**/api/rfp-intake/triage/requests/rfp-triage-1/proposal-draft/publish', async (route) => {
      publishBodies.push(route.request().postDataJSON());
      phase = 'published';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(currentDetail()) });
    });
    await page.route('**/api/rfp-intake/mentions/candidates**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ userId: 'owner-1', displayName: 'Owner', email: 'owner@example.com' }]),
      });
    });

    await loginAsPersona('ba');
    await page.goto('/rfp-intake/rfp-triage-1');
    await page.getByTestId('rfp-wizard-step-2').click({ timeout: 15_000 });
    await expect(page.getByTestId('rfp-wizard-step-3')).toBeDisabled();
    await expect(page.getByTestId('rfp-arch-sizing')).toBeVisible();
    await page.getByTestId('rfp-arch-app-type').selectOption('console');
    await page.getByTestId('rfp-arch-resource-rds').check();
    await expect(page.getByTestId('rfp-wizard-submit-review')).toHaveText('Submit for proposal');
    await page.getByTestId('rfp-wizard-submit-review').click();

    await expect(page.getByTestId('rfp-proposal-progress')).toBeVisible({ timeout: 15_000 });
    expect(submitBodies[0]).toMatchObject({ architecture: { appType: 'console', resources: ['rds'], sizing: { sizingProfile: 'medium' } } });
    await expect(page.getByTestId('rfp-proposal-editor')).toBeVisible({ timeout: 20_000 });

    await expect(page.getByTestId('rfp-cost-source-rds-prod')).toHaveAttribute('href', /pricing\.us-east-1\.amazonaws\.com/);
    await page.getByTestId('rfp-cost-confirm-rds-prod').check();
    await page.getByTestId('rfp-cost-implementation-1-low').fill('20000');
    await page.getByTestId('rfp-cost-implementation-1-expected').fill('30000');
    await page.getByTestId('rfp-cost-implementation-1-high').fill('40000');
    await page.getByTestId('rfp-cost-confirm-implementation-1').check();
    await page.getByTestId('rfp-proposal-owner-search').fill('Own');
    await page.getByTestId('rfp-proposal-owner-owner-1').click();
    await page.getByTestId('rfp-proposal-publish').click();

    await expect(page.getByTestId('rfp-proposal-published')).toBeVisible({ timeout: 15_000 });
    expect(publishBodies[0]).toEqual({ productOwnerId: 'owner-1' });
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
    await page.getByTestId('rfp-wizard-step-2').click({ timeout: 15_000 });
    await expect(page.getByTestId('rfp-comment-composer')).toBeVisible();
    await page.getByTestId('rfp-comment-input').fill('Need a screenshot @Ow');
    await expect(page.getByTestId('rfp-mention-picker')).toBeVisible();
    await page.getByTestId('rfp-mention-owner-1').click();
    await page.getByTestId('rfp-comment-submit').click();
    await expect(page.getByTestId('rfp-activity-list')).toBeVisible();
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
    await page.getByTestId('rfp-wizard-step-2').click({ timeout: 15_000 });
    await expect(page.getByTestId('rfp-attachment-input')).toBeVisible();
    await page.getByTestId('rfp-attachment-input').setInputFiles({
      name: 'huge.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    await expect(page.getByRole('alert')).toContainText(/exceeds 10 MB/i);
  });
});
