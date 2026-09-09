/**
 * FEAT-001 / FEAT-002 dashboard and shared slide-out acceptance coverage.
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../support/fixtures';
import type { Persona } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';

const emptyPayload = {
  incompletePipeline: {
    status: 'empty',
    data: {
      updatedAt: '2026-08-31T12:00:00Z',
      groups: [
        { key: 'interview', label: 'Interviews', count: 0, rows: [], viewAllHref: '/backlog/interviews' },
        { key: 'prd', label: 'PRDs', count: 0, rows: [], viewAllHref: '/backlog/prds' },
        { key: 'testCase', label: 'Test Cases', count: 0, rows: [], viewAllHref: '/backlog/test-cases' },
        { key: 'prototype', label: 'Prototypes', count: 0, rows: [], viewAllHref: '/backlog/prototypes' },
        { key: 'designDoc', label: 'Design Docs', count: 0, rows: [], viewAllHref: '/backlog/design-docs' },
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
    data: {
      ready: 0,
      inProgress: 0,
      cycleTime: { medianDays: null, sampleSize: 0, windowDays: 90 },
    },
  },
  openBugsOnPbis: { status: 'empty', data: { totalOpenBugs: 0, rows: [] } },
  bugToPbiRatio: { status: 'empty', data: { bugCount: 0, pbiCount: 0, ratio: null, windowDays: 90 } },
  devToProduction: { status: 'empty', data: { medianDays: null, sampleSize: 0, windowDays: 90 } },
};

async function openHome(
  page: Page,
  loginAsPersona: (persona: Persona) => Promise<void>,
) {
  await stubAdoProjects(page);
  await loginAsPersona('developer');
  await page.goto('/home');
  await expect(page.getByTestId('home-dashboard-root')).toBeVisible();
}

test.describe('Home dashboard and slide-out chat', () => {
  test('FEAT-001 renders full data and navigates from a pipeline row', async ({ page, loginAsPersona }) => {
    await page.route('**/api/home-dashboard?project=*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...emptyPayload,
          incompletePipeline: {
            status: 'ok',
            data: {
              updatedAt: '2026-08-31T12:00:00Z',
              groups: [{
                key: 'interview',
                label: 'Interviews',
                count: 1,
                viewAllHref: '/backlog/interviews',
                rows: [{
                  id: 'interview-1',
                  name: 'Dashboard interview',
                  route: '/backlog/interview/interview-1',
                  updatedAt: '2026-08-30T12:00:00Z',
                  ageDays: 1,
                }],
              }],
            },
          },
        }),
      });
    });
    await openHome(page, loginAsPersona);

    const row = page.getByTestId('home-dashboard-pipeline-row-interview-interview-1');
    await expect(row).toContainText('Dashboard interview');
    await row.click();
    await expect(page).toHaveURL(/\/backlog\/interview\/interview-1/);
  });

  test('FEAT-001 renders empty and permission-scoped tiles without exposing null slices', async ({ page, loginAsPersona }) => {
    await page.route('**/api/home-dashboard?project=*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...emptyPayload,
          openBugsOnPbis: null,
          bugToPbiRatio: null,
          devToProduction: null,
        }),
      });
    });
    await openHome(page, loginAsPersona);

    await expect(page.getByText('No incomplete interviews in this project.')).toBeVisible();
    await expect(page.getByTestId('home-dashboard-bugs-card')).toHaveCount(0);
    await expect(page.getByTestId('home-dashboard-devprod-card')).toHaveCount(0);
  });

  test('FEAT-002 toggles a keyboard-accessible full-height narrow slide-out and returns to the dashboard', async ({ page, loginAsPersona }) => {
    await page.route('**/api/home-dashboard?project=*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(emptyPayload) });
    });
    await page.setViewportSize({ width: 720, height: 900 });
    await openHome(page, loginAsPersona);

    const toggle = page.getByTestId('home-chat-toggle-btn');
    await toggle.focus();
    await page.keyboard.press('Enter');
    const shell = page.getByTestId('agent-slideout-shell');
    await expect(shell).toBeVisible();
    await expect(shell).toHaveCSS('width', '720px');
    await page.getByTestId('chat-agent-close-btn').click();
    await expect(shell).toHaveCount(0);
    await expect(page.getByTestId('home-dashboard-root')).toBeVisible();
  });

  test('FEAT-002 hides the chat toggle when chat permissions are absent', async ({ page, loginAsPersona }) => {
    await page.route('**/api/me/permissions**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ permissions: ['home:view'], roles: [], groups: [] }),
      });
    });
    await page.route('**/api/home-dashboard?project=*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(emptyPayload) });
    });
    await openHome(page, loginAsPersona);
    await expect(page.getByTestId('home-chat-toggle-btn')).toHaveCount(0);
  });
});
