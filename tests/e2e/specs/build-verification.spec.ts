/**
 * FEAT-011 — Build Verification Matrix & Evidence (VT-34):
 * matrix columns, status text, summary line, deferral reason, red evidence dialog, and missing-blob 404 resilience.
 */
import type { Page } from '@playwright/test';
import { expect, test, E2E_PROJECT, SeedApi } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';
import { DEFAULT_ENABLED_MENU_VIEWS } from '../../../src/shared/types/menuSettings';
import type {
  BuildDetailResponse,
  BuildVerificationMatrixResponse,
} from '../../../src/shared/types/buildView';

const BUILD_ID = '00000000-0000-4000-8000-0000000000b1';
const ROW_AC1_ID = '00000000-0000-4000-8000-000000000101';
const ROW_BR1_ID = '00000000-0000-4000-8000-000000000102';
const ROW_NFR1_ID = '00000000-0000-4000-8000-000000000103';

const DETAIL: BuildDetailResponse = {
  build: {
    id: BUILD_ID,
    project: E2E_PROJECT,
    repository: 'apex',
    status: 'preview_ready',
    currentRevisionNumber: 1,
    intakeInterviewId: null,
    createdAt: '2026-10-28T10:00:00.000Z',
    endedAt: null,
  },
  stage: {
    kind: 'stage',
    key: 'preview_ready',
    tasks: { merged: 2, total: 2 },
    queuePosition: null,
    suspendReason: null,
  },
  timing: {
    elapsedSeconds: 180,
    targetSeconds: 300,
    state: 'within',
    includesDeployment: true,
  },
  caps: {
    cost: { usedUsd: '1.5000', limitUsd: '25.0000' },
    revisions: { used: 0, limit: 5 },
    elapsedSeconds: { used: 180, limit: 3600 },
    parallelism: { used: 1, limit: 3 },
  },
  supportContacts: [{ displayName: 'Dana', email: 'dana@example.com' }],
  revisions: [
    {
      number: 1,
      createdAt: '2026-10-28T10:00:00.000Z',
      classification: 'small',
      deploymentStatus: 'succeeded',
      previewUrl: 'https://preview.example.com',
    },
  ],
  currentRevision: {
    number: 1,
    classification: 'small',
    repairAttempts: 0,
    brief: {
      status: 'ok',
      overview: 'Verification summary feature.',
      requirements: [],
      assumptions: [],
      exclusions: [],
      riskDecisions: [],
    },
    tasks: [],
  },
  verificationSummary: { total: 3, pass: 2, fail: 0, deferred: 1, retired: 0 },
  lease: null,
};

const VERIFICATION: BuildVerificationMatrixResponse = {
  buildId: BUILD_ID,
  revisionNumber: 1,
  revisionNumbers: [1],
  summary: { total: 3, pass: 2, fail: 0, deferred: 1, retired: 0 },
  rows: [
    {
      id: ROW_AC1_ID,
      requirementId: 'AC-1',
      kind: 'ac',
      requirementText: 'Users see each requirement row with red and green evidence.',
      tier: 'unit',
      status: 'pass',
      testReferences: [
        {
          file: 'src/client/components/__tests__/BuildVerificationTab.test.tsx',
          name: 'renders matrix rows and evidence buttons',
        },
      ],
      red: {
        commit: '1111111111111111111111111111111111111111',
        command: 'npx jest BuildVerificationTab',
        exitCode: 1,
        recordedAt: '2026-10-28T10:05:00.000Z',
      },
      green: {
        commit: '2222222222222222222222222222222222222222',
        command: 'npx jest BuildVerificationTab',
        exitCode: 0,
        recordedAt: '2026-10-28T10:06:00.000Z',
      },
      deferralReason: null,
    },
    {
      id: ROW_BR1_ID,
      requirementId: 'BR-1',
      kind: 'br',
      requirementText: 'Evidence is required for every requirement a task owns.',
      tier: 'unit',
      status: 'pass',
      testReferences: [
        {
          file: 'src/server/__tests__/verificationEvidenceChecker.test.ts',
          name: 'rejects missing red or green evidence',
        },
      ],
      red: {
        commit: '3333333333333333333333333333333333333333',
        command: 'npx jest verificationEvidenceChecker',
        exitCode: 1,
        recordedAt: '2026-10-28T10:07:00.000Z',
      },
      green: {
        commit: '4444444444444444444444444444444444444444',
        command: 'npx jest verificationEvidenceChecker',
        exitCode: 0,
        recordedAt: '2026-10-28T10:08:00.000Z',
      },
      deferralReason: null,
    },
    {
      id: ROW_NFR1_ID,
      requirementId: 'NFR-1',
      kind: 'nfr',
      requirementText: 'The Verification tab loads within 1 second.',
      tier: 'e2e',
      status: 'deferred',
      testReferences: [],
      red: null,
      green: null,
      deferralReason: 'Deferred to performance benchmark suite.',
    },
  ],
};

const RED_EVIDENCE_TEXT =
  'FAIL src/client/components/__tests__/BuildVerificationTab.test.tsx\nExpected element to be visible';

async function selectProject(page: Page): Promise<void> {
  await page.addInitScript((p) => {
    window.localStorage.setItem('selectedProject', p);
    window.localStorage.setItem('selectedAreaPath', p);
  }, E2E_PROJECT);
}

async function forceBuildFlagOn(page: Page): Promise<void> {
  await page.route('**/api/feature-flags/evaluate*', async (route) => {
    const response = await route.fetch();
    const data = (await response.json().catch(() => ({}))) as { flags?: Record<string, boolean> };
    await route.fulfill({
      response,
      json: { ...data, flags: { ...(data.flags ?? {}), 'build-from-prompt': true } },
    });
  });
}

async function stubBuildVerificationRoutes(page: Page): Promise<void> {
  await page.route(`**/api/builds/${BUILD_ID}?*`, (route) =>
    route.fulfill({ json: DETAIL }),
  );
  await page.route(`**/api/builds/${BUILD_ID}/verification*`, (route) =>
    route.fulfill({ json: VERIFICATION }),
  );
  await page.route(`**/api/builds/${BUILD_ID}/evidence/${ROW_AC1_ID}/red*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      body: RED_EVIDENCE_TEXT,
    }),
  );
  await page.route(`**/api/builds/${BUILD_ID}/evidence/${ROW_BR1_ID}/red*`, (route) =>
    route.fulfill({
      status: 404,
      json: {
        error: 'Evidence is no longer available.',
        code: 'BUILD_EVIDENCE_NOT_AVAILABLE',
      },
    }),
  );
}

test.describe('Build Verification Tab @feat-011', () => {
  test.beforeEach(async ({ page, request }) => {
    await SeedApi.setMenuSettings(request, E2E_PROJECT, [...DEFAULT_ENABLED_MENU_VIEWS, 'builds']);
    await stubAdoProjects(page);
    await forceBuildFlagOn(page);
    await stubBuildVerificationRoutes(page);
    await selectProject(page);
  });

  test('VT-34 PBI-023 AC-0..AC-2: renders matrix, deferral reason, red evidence dialog, and missing-blob 404 message', async ({
    page,
    loginAsPersona,
  }) => {
    await loginAsPersona('developer');
    await page.goto(`/builds/${BUILD_ID}/verification`);

    await expect(page.getByTestId('build-verification-tab')).toBeVisible();
    const matrix = page.getByTestId('build-verification-matrix');
    await expect(matrix).toBeVisible();

    const headers = matrix.locator('thead th');
    await expect(headers).toHaveText([
      'ID',
      'Kind',
      'Requirement',
      'Tier',
      'Status',
      'Test reference',
      'Red evidence',
      'Green evidence',
    ]);

    await expect(page.getByTestId('build-verification-summary')).toHaveText(
      '3 requirements: 2 passed, 0 failing, 1 deferred, 0 retired.',
    );
    await expect(page.getByTestId('build-verification-status-AC-1')).toHaveText('Passed');
    await expect(page.getByTestId('build-verification-status-NFR-1')).toHaveText('Deferred');
    await expect(page.getByTestId('build-verification-deferral-reason-NFR-1')).toHaveText(
      'Deferred to performance benchmark suite.',
    );

    await page.getByTestId('build-verification-red-evidence-AC-1').click();
    await expect(page.getByTestId('build-evidence-dialog')).toBeVisible();
    await expect(page.getByTestId('build-evidence-content')).toHaveText(RED_EVIDENCE_TEXT);
    await page.getByTestId('build-evidence-close').click();
    await expect(page.getByTestId('build-evidence-dialog')).toHaveCount(0);

    await page.getByTestId('build-verification-red-evidence-BR-1').click();
    await expect(page.getByTestId('build-evidence-dialog')).toBeVisible();
    await expect(page.getByTestId('build-evidence-unavailable')).toHaveText(
      'This evidence is no longer available. Evidence is kept for 90 days after a build ends.',
    );
    await page.getByTestId('build-evidence-close').click();
    await expect(page.getByTestId('build-evidence-dialog')).toHaveCount(0);

    await expect(matrix).toBeVisible();
    await expect(page.getByTestId('build-verification-red-evidence-AC-1')).toBeEnabled();
  });
});
