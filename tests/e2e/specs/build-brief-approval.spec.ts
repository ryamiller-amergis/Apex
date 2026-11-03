/**
 * FEAT-006 — approve a build brief from the interview chat view.
 *
 * The seed API cannot create a build-intake interview, so the spec seeds a normal interview and stubs
 * its GET to report the build-intake profile. The brief, analysis and approve calls are stubbed, so the
 * spec exercises the panel; the server rules are covered by `buildBriefRoutes.test.ts`.
 */
import type { Page } from '@playwright/test';
import { expect, test, E2E_PROJECT, PERSONA_OIDS, SeedApi } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';
import type { BuildBriefAnalysisResponse } from '../../../src/shared/types/build';
import type { InterviewBriefRecord } from '../../../src/shared/types/interview';

const REQUESTER = PERSONA_OIDS.developer;

interface BriefStubs {
  approveCalls: number;
}

function makeBrief(interviewId: string, status: 'draft' | 'approved'): InterviewBriefRecord {
  return {
    id: 'brief-e2e',
    interviewId,
    status,
    version: 1,
    sections: {
      problemAndOutcome: 'Managers track team leave.',
      users: 'Managers',
      scope: 'One leave page',
      businessRules: '',
      scenarios: 'A manager approves a leave request.',
      acceptanceCriteria: 'AC-1: The page lists leave requests.',
      assumptions: 'None',
      unresolvedItems: [],
    },
    approvedBy: status === 'approved' ? REQUESTER : null,
    approvedAt: status === 'approved' ? '2026-10-27T10:00:00Z' : null,
  };
}

function makeAnalysis(
  interviewId: string,
  options: { approved: boolean; mayEdit: boolean; actingFor: string | null; approver: string },
): BuildBriefAnalysisResponse {
  return {
    interviewId,
    buildRunId: 'build-e2e',
    revisionNumber: 1,
    briefVersion: 1,
    briefStatus: options.approved ? 'approved' : 'draft',
    requirements: [{ id: 'AC-1', kind: 'ac', text: 'The page lists leave requests.', retired: false }],
    riskDecisions: [
      { id: 'RD-1', category: 'access', rating: 'medium', decision: 'Add a leave:approve permission.', rationale: 'Only managers approve.' },
    ],
    classification: { value: 'small', reasons: [] },
    requester: { id: REQUESTER, displayName: 'Dev User' },
    approval: options.approved
      ? { approvedBy: { id: 'approver', displayName: options.approver }, approvedAt: '2026-10-27T10:00:00Z' }
      : null,
    viewer: { mayEdit: options.mayEdit, actingFor: options.actingFor },
  };
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

async function stubBuildBrief(
  page: Page,
  interviewId: string,
  options: { mayEdit: boolean; actingFor: string | null; approver: string; approveStatus?: number },
): Promise<BriefStubs> {
  const stubs: BriefStubs = { approveCalls: 0 };
  let approved = false;

  await page.route(`**/api/interviews/${interviewId}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const data = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: { ...data, playbookRunId: 'run-e2e', playbookProfileKey: 'build-intake' },
    });
  });
  await page.route(`**/api/interviews/${interviewId}/brief`, async (route) => {
    await route.fulfill({ json: makeBrief(interviewId, approved ? 'approved' : 'draft') });
  });
  await page.route(`**/api/interviews/${interviewId}/brief/analysis`, async (route) => {
    await route.fulfill({ json: makeAnalysis(interviewId, { ...options, approved }) });
  });
  await page.route(`**/api/interviews/${interviewId}/brief/approve`, async (route) => {
    stubs.approveCalls += 1;
    if (options.approveStatus && options.approveStatus !== 200) {
      await route.fulfill({
        status: options.approveStatus,
        json: { error: 'Only the requester, a Project Admin or a Platform Admin can change or approve this brief.' },
      });
      return;
    }
    approved = true;
    await route.fulfill({
      json: { version: 1, resumed: true, alreadyApproved: false, classification: { value: 'small', reasons: [] } },
    });
  });
  return stubs;
}

async function openInterview(page: Page, interviewId: string): Promise<void> {
  await page.addInitScript((project) => {
    window.localStorage.setItem('selectedProject', project);
    window.localStorage.setItem('selectedAreaPath', project);
  }, E2E_PROJECT);
  await page.goto(`/backlog/interview/${interviewId}`);
  await expect(page.getByTestId('build-brief-review')).toBeVisible();
}

test.describe('Build brief approval @feat-006', () => {
  let interviewId: string;

  test.beforeEach(async ({ page, request }) => {
    const seeded = await SeedApi.seedInterview(request, {
      authorId: REQUESTER,
      project: E2E_PROJECT,
      title: 'Build: team leave page',
    });
    interviewId = seeded.id;
    await stubAdoProjects(page);
    await forceBuildFlagOn(page);
  });

  test.afterEach(async ({ request }) => {
    await SeedApi.reset(request);
  });

  test('VT-37 the requester approves the brief in one step', async ({ page, loginAsPersona }) => {
    const stubs = await stubBuildBrief(page, interviewId, { mayEdit: true, actingFor: null, approver: 'Dev User' });
    await loginAsPersona('developer');
    await openInterview(page, interviewId);

    await expect(page.getByTestId('build-requirement-row-AC-1')).toBeVisible();
    await expect(page.getByTestId('build-brief-classification')).toContainText('Small build');
    await page.getByTestId('build-brief-approve').click();

    await expect(page.getByTestId('build-brief-approved-note')).toContainText('Approved by Dev User');
    await expect(page.getByTestId('build-brief-approve')).toHaveCount(0);
    expect(stubs.approveCalls).toBe(1);
  });

  test('VT-38 a Project Admin approves for the requester', async ({ page, loginAsPersona }) => {
    await stubBuildBrief(page, interviewId, { mayEdit: true, actingFor: 'Dev User', approver: 'Manager User' });
    await loginAsPersona('manager');
    await openInterview(page, interviewId);

    await expect(page.getByTestId('build-brief-takeover-notice')).toHaveText('You are editing this brief for Dev User.');
    await page.getByRole('button', { name: 'Approve brief for Dev User' }).click();
    await expect(page.getByTestId('build-brief-approved-note')).toContainText('Approved by Manager User');
  });

  test('VT-39 a BA who is not the requester cannot approve', async ({ page, loginAsPersona }) => {
    const stubs = await stubBuildBrief(page, interviewId, {
      mayEdit: false,
      actingFor: null,
      approver: 'BA User',
      approveStatus: 403,
    });
    await loginAsPersona('ba');
    await openInterview(page, interviewId);

    await expect(page.getByTestId('build-brief-readonly-note')).toHaveText(
      'You can read this brief. Only the requester or an admin can change or approve it.',
    );
    await expect(page.getByTestId('build-brief-approve')).toHaveCount(0);
    await expect(page.getByTestId('build-brief-approved-note')).toHaveCount(0);
    expect(stubs.approveCalls).toBe(0);
  });
});
