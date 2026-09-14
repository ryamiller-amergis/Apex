/**
 * FEAT-002 Home pill access — visibility and blocked-start coverage.
 *
 * The server already proves identity/group filtering (see
 * apiRoutes.skillConfig.test.ts). Here we stub the two caller-shaped
 * `GET /api/skill-config` responses so the Home composer can be asserted for an
 * allowed caller and a caller who is on no pill's allow-list.
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../support/fixtures';
import type { Persona } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';

const BLOCKED_NOTICE =
  "You don't have access to any Home skills on this project."
  + " Ask a Project Admin to add you to a pill's allow-list.";

const emptyDashboardPayload = {
  incompletePipeline: {
    status: 'empty',
    data: {
      updatedAt: '2026-08-31T12:00:00Z',
      groups: [
        { key: 'interview', label: 'Interviews', count: 0, rows: [], viewAllHref: '/backlog/interviews' },
      ],
    },
  },
  artifactCycleTime: {
    status: 'empty',
    data: {
      interview: { medianDays: null, sampleSize: 0, windowDays: 90 },
      prd: { medianDays: null, sampleSize: 0, windowDays: 90 },
      testCase: { medianDays: null, sampleSize: 0, windowDays: 90 },
      designDoc: { medianDays: null, sampleSize: 0, windowDays: 90 },
    },
  },
  myWork: {
    status: 'empty',
    data: { ready: 0, inProgress: 0, cycleTime: { medianDays: null, sampleSize: 0, windowDays: 90 } },
  },
  openBugsOnPbis: { status: 'empty', data: { totalOpenBugs: 0, rows: [] } },
  bugToPbiRatio: { status: 'empty', data: { bugCount: 0, pbiCount: 0, ratio: null, windowDays: 90 } },
  devToProduction: { status: 'empty', data: { medianDays: null, sampleSize: 0, windowDays: 90 } },
};

interface SkillConfigStub {
  quickSkillPills: Array<{ label: string; skillPath: string; model?: string; description?: string | null }>;
  quickMcpPills: Array<{ label: string; mcpServerName: string; model?: string; description?: string | null }>;
  homePillsConfigured: boolean;
}

/** Serve the caller-filtered skill-config payload the signed-in user would receive. */
async function stubSkillConfig(page: Page, config: SkillConfigStub): Promise<void> {
  await page.route('**/api/skill-config?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-skill-config',
        project: 'MaxView',
        friendlyName: 'MaxView',
        isDefault: true,
        skillRepo: 'e2e/skills',
        skillBranch: 'main',
        ...config,
      }),
    });
  });
}

async function openHomeChat(
  page: Page,
  loginAsPersona: (persona: Persona) => Promise<void>,
): Promise<void> {
  await stubAdoProjects(page);
  await page.route('**/api/skills/list*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/api/home-dashboard?project=*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(emptyDashboardPayload),
    });
  });
  await loginAsPersona('developer');
  await page.goto('/home');
  await expect(page.getByTestId('home-dashboard-root')).toBeVisible();
  await page.getByTestId('home-chat-toggle-btn').click();
  await expect(page.getByTestId('agent-slideout-shell')).toBeVisible();
}

test.describe('Home pill access', () => {
  test('PBI-003 AC-0 an allowed caller sees their skill pill and can compose', async ({ page, loginAsPersona }) => {
    await stubSkillConfig(page, {
      quickSkillPills: [{ label: 'Write PRD', skillPath: '/to-prd', model: 'auto' }],
      quickMcpPills: [],
      homePillsConfigured: true,
    });
    await openHomeChat(page, loginAsPersona);

    await expect(page.getByTestId('chat-agent-skill-pill-to-prd')).toBeVisible();
    await expect(page.getByTestId('chat-agent-home-blocked-notice')).toHaveCount(0);

    await page.getByTestId('chat-agent-skill-pill-to-prd').click();
    await page.getByTestId('chat-agent-message-input').fill('Turn my interview into a PRD');
    await expect(page.getByTestId('chat-agent-send-btn')).toBeEnabled();
  });

  test('PBI-006 AC-0 a caller on no allow-list sees no pills, the blocked notice, and a disabled send', async ({ page, loginAsPersona }) => {
    await stubSkillConfig(page, {
      quickSkillPills: [],
      quickMcpPills: [],
      homePillsConfigured: true,
    });
    await openHomeChat(page, loginAsPersona);

    await expect(page.getByTestId('chat-agent-skill-pill-to-prd')).toHaveCount(0);

    const notice = page.getByTestId('chat-agent-home-blocked-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText(BLOCKED_NOTICE);
    await expect(notice).toHaveAttribute('role', 'status');
    await expect(notice).toHaveAttribute('aria-live', 'polite');

    await expect(page.getByTestId('chat-agent-message-input')).toBeDisabled();
    await expect(page.getByTestId('chat-agent-send-btn')).toBeDisabled();
  });

  test('PBI-006 AC-2 a project with no configured pills keeps free chat available', async ({ page, loginAsPersona }) => {
    await stubSkillConfig(page, {
      quickSkillPills: [],
      quickMcpPills: [],
      homePillsConfigured: false,
    });
    await openHomeChat(page, loginAsPersona);

    await expect(page.getByTestId('chat-agent-home-blocked-notice')).toHaveCount(0);
    await page.getByTestId('chat-agent-message-input').fill('Tell me what changed this week');
    await expect(page.getByTestId('chat-agent-send-btn')).toBeEnabled();
  });
});
