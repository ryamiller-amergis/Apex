/**
 * AC: Process-Agnostic Living Roadmap Workbench (/planning/roadmap)
 *
 * Stubs external Azure DevOps endpoints while letting /api/projects/:projectId/roadmap*
 * and /api/feature-requests* hit the real Express backend and PostgreSQL aipilot_e2e DB.
 */
import fs from 'fs';
import path from 'path';
import { test, expect, SeedApi } from '../support/fixtures';
import {
  stubAdoProjects,
  stubAdoWorkItems,
  suppressBetaAnnouncement,
  suppressSseStreams,
  type StubWorkItem,
} from '../support/api-stubs';
import { PlanningRoadmapPage } from '../pages/planning-roadmap.page';

test.use({
  video: { mode: 'on', size: { width: 1440, height: 900 } },
  viewport: { width: 1440, height: 900 },
});

function formatRelativeIsoDate(offsetDays: number): string {
  const now = new Date();
  const utc = new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays),
  );
  const yyyy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const CAPTURE_DIR = '/tmp/roadmap-e2e-captures';

test.describe('Living Roadmap Workbench (/planning/roadmap)', () => {
  test.beforeEach(async ({ page, e2eApi }) => {
    await e2eApi.post('/e2e/reset');
    await page.addInitScript(() => {
      window.localStorage.setItem('selectedProject', 'MaxView');
      window.localStorage.setItem('selectedAreaPath', 'MaxView');
    });
    await suppressSseStreams(page);
    await suppressBetaAnnouncement(page);
    await page.route('**/api/feature-flags/evaluate*', async (route) => {
      try {
        const response = await route.fetch();
        const data = (await response.json()) as { flags?: Record<string, boolean> };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            flags: {
              ...(data?.flags ?? {}),
              'beta-to-prod-announcement': false,
              'work-board': false,
            },
          }),
        });
      } catch {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            flags: { 'beta-to-prod-announcement': false, 'work-board': false },
          }),
        });
      }
    });
    await stubAdoProjects(page);
  });

  test.afterEach(async ({ e2eApi }) => {
    await e2eApi.post('/e2e/reset');
  });

  test('manages undated ADO Epics, Apex baselines & slip ghosts, sandbox ideas, promotion, and audit ledger with full PostgreSQL persistence', async ({
    page,
    loginAsPersona,
  }) => {
    test.setTimeout(90_000);
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });

    const plannedStartYmd = formatRelativeIsoDate(-7);
    const initialTargetYmd = formatRelativeIsoDate(18);
    const adoDatedTargetYmd = formatRelativeIsoDate(38);
    const childInferredYmd = formatRelativeIsoDate(28);

    const stubEpics: StubWorkItem[] = [
      {
        id: 8101,
        title: '[E2E] Provider Credentialing Hub',
        type: 'Epic',
        state: 'New',
        assignedTo: 'Jordan PO',
        targetDate: null,
      },
      {
        id: 8102,
        title: '[E2E] Claims Attachment Intake',
        type: 'Epic',
        state: 'In Progress',
        assignedTo: 'Casey Lead',
        targetDate: null,
      },
      {
        id: 8103,
        title: '[E2E] Billing EDI 837 Modernization',
        type: 'Epic',
        state: 'Active',
        assignedTo: 'Morgan Architect',
        targetDate: adoDatedTargetYmd,
      },
    ];

    await stubAdoWorkItems(page, stubEpics);

    // Stub /api/epics/:id/children so weighted rollup & child-date inference work deterministically
    await page.route('**/api/epics/*/children*', (route) => {
      const url = route.request().url();
      if (url.includes('/epics/8102/children')) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 8201,
              title: '[E2E] OCR Document Classifier',
              state: 'Done',
              workItemType: 'Feature',
              assignedTo: 'Alex Dev',
              targetDate: childInferredYmd,
              areaPath: 'MaxView',
              iterationPath: 'MaxView',
              changedDate: new Date().toISOString(),
              createdDate: new Date().toISOString(),
            },
            {
              id: 8202,
              title: '[E2E] Payer Portal Webhook',
              state: 'In Progress',
              workItemType: 'Feature',
              assignedTo: 'Sam Dev',
              areaPath: 'MaxView',
              iterationPath: 'MaxView',
              changedDate: new Date().toISOString(),
              createdDate: new Date().toISOString(),
            },
          ]),
        });
        return;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    // Stub /api/releases* background prefetches so they never hit live ADO
    await page.route('**/api/releases*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await loginAsPersona('product-owner');

    const roadmap = new PlanningRoadmapPage(page);
    await roadmap.goto();

    // 1. Verify undated ADO Epics appear immediately in Horizon Board instead of a blank view
    await expect(roadmap.horizonColumn('unplanned')).toContainText(
      '[E2E] Provider Credentialing Hub',
    );
    await expect(roadmap.horizonColumn('now')).toContainText(
      '[E2E] Claims Attachment Intake',
    );
    await expect(roadmap.horizonColumn('now')).toContainText(
      'Inferred (Children)',
    );
    await expect(roadmap.horizonColumn('now')).toContainText(
      '[E2E] Billing EDI 837 Modernization',
    );

    // 2. Select undated Epic in Inspector, move to Now + lock initial Apex Planned Target Date & Baseline
    await roadmap.selectItemByTitle('[E2E] Provider Credentialing Hub');
    await page.getByTestId('roadmap-inspector-horizon').selectOption('now');
    await page
      .getByTestId('roadmap-inspector-start-date')
      .fill(plannedStartYmd);
    await page
      .getByTestId('roadmap-inspector-target-date')
      .fill(initialTargetYmd);
    await page
      .getByTestId('roadmap-inspector-reason')
      .selectOption('Initial Baseline');
    await page
      .getByTestId('roadmap-inspector-note')
      .fill('Committed Q4 credentialing target');
    await page.getByTestId('roadmap-inspector-save').click();

    await expect(roadmap.horizonColumn('now')).toContainText(
      '[E2E] Provider Credentialing Hub',
    );
    await expect(roadmap.horizonColumn('now')).toContainText('On baseline');

    // Shift target date by +2w (+14d) with reason Scope Expansion and note
    await page.getByTestId('roadmap-shift-plus-2w').click();
    await page
      .getByTestId('roadmap-inspector-reason')
      .selectOption('Scope Expansion');
    await page
      .getByTestId('roadmap-inspector-note')
      .fill('Added multi-state license verification rules');
    await page.getByTestId('roadmap-inspector-save').click();

    await expect(roadmap.horizonColumn('now')).toContainText('+14d');

    // 3. Create an Ad-hoc Sandbox Idea via + New Ad-hoc Idea
    await roadmap.createAdhocIdea({
      title: '[E2E] Prior Auth Auto-Triage',
      ownerLabel: 'Sarah Jenkins (BA)',
      horizon: 'next',
      effortSize: 'L',
      notes: 'Triage incoming EDI 278 clinical attachments before nurse review',
    });

    await expect(roadmap.horizonColumn('next')).toContainText(
      '[E2E] Prior Auth Auto-Triage',
    );

    // Close inspector briefly to capture crisp full-width Horizon Board screenshot
    await roadmap.inspector().getByRole('button', { name: 'Close inspector' }).click();
    await page.screenshot({
      path: path.join(CAPTURE_DIR, 'planning_roadmap_horizons.png'),
    });

    // Switch to Living Timeline: verify Baseline Ghost, +14d slip badge, Today marker, and Unscheduled Tray
    await roadmap.switchMode('timeline');
    await expect(page.getByTestId('roadmap-today-marker')).toBeVisible();
    await expect(page.getByTestId('roadmap-baseline-ghost')).toBeVisible();
    await expect(
      page.getByTestId('roadmap-timeline-row-wi-8101'),
    ).toContainText('+14d');
    await expect(roadmap.unscheduledTray()).toContainText(
      '[E2E] Prior Auth Auto-Triage',
    );
    await page.screenshot({
      path: path.join(CAPTURE_DIR, 'planning_roadmap_timeline.png'),
    });

    // Switch to Planning Sheet: verify tabular columns and both Epics + Draft Idea
    await roadmap.switchMode('sheet');
    await expect(roadmap.sheetTable()).toContainText(
      '[E2E] Provider Credentialing Hub',
    );
    await expect(roadmap.sheetTable()).toContainText('+14d');
    await expect(roadmap.sheetTable()).toContainText(
      '[E2E] Prior Auth Auto-Triage',
    );
    await page.screenshot({
      path: path.join(CAPTURE_DIR, 'planning_roadmap_sheet.png'),
    });

    // 4. Promote Ad-hoc Idea to Feature Request via Inspector and verify Drift & History Ledger
    await roadmap.selectItemByTitle('[E2E] Prior Auth Auto-Triage');
    await page.getByTestId('roadmap-promote-idea-btn').click();
    await expect(page.getByTestId('roadmap-promote-idea-btn')).toHaveText(
      'Promoted to Feature Request',
    );

    // Close inspector and open Drift & History Ledger
    await roadmap.inspector().getByRole('button', { name: 'Close inspector' }).click();
    await roadmap.switchMode('history');

    const historyTable = roadmap.historyTable();
    await expect(historyTable).toContainText('idea_created');
    await expect(historyTable).toContainText('baseline_locked');
    await expect(historyTable).toContainText('date_changed');
    await expect(historyTable).toContainText('idea_promoted');
    await expect(historyTable).toContainText('Scope Expansion');
    await expect(historyTable).toContainText(
      'Added multi-state license verification rules',
    );
    await page.screenshot({
      path: path.join(CAPTURE_DIR, 'planning_roadmap_history.png'),
    });

    // Reload the page and assert full PostgreSQL persistence across views!
    await page.reload();
    await roadmap.waitForReady();

    await expect(roadmap.horizonColumn('now')).toContainText(
      '[E2E] Provider Credentialing Hub',
    );
    await expect(roadmap.horizonColumn('now')).toContainText('+14d');
    await expect(roadmap.horizonColumn('next')).toContainText(
      '[E2E] Prior Auth Auto-Triage',
    );
    await expect(roadmap.horizonColumn('next')).toContainText(
      'Promoted · Feature Request',
    );

    await roadmap.switchMode('history');
    await expect(roadmap.historyTable()).toContainText('idea_promoted');
    await expect(roadmap.historyTable()).toContainText('date_changed');
  });
});

// Ensure SeedApi remains referenced cleanly if used by helpers
void SeedApi;
