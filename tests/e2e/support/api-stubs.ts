/**
 * Playwright route stubs for external service calls.
 *
 * All live ADO, AI (Bedrock/Cursor), and Teams calls are intercepted and
 * replaced with deterministic fixture data so E2E tests are fast, free, and
 * offline-capable. Never let real network calls to external systems through
 * in a Playwright test.
 */
import type { Page } from '@playwright/test';
import type { EvaluateFlagsResponse } from '../../../src/shared/types/featureFlags';

// ── ADO work item stubs ────────────────────────────────────────────────────────

export interface StubWorkItem {
  id: number;
  title: string;
  type: string;
  state: string;
  assignedTo?: string;
  dueDate?: string | null;
  targetDate?: string | null;
  areaPath?: string;
  iterationPath?: string;
  parentId?: number;
}

const DEFAULT_WORK_ITEMS: StubWorkItem[] = [
  { id: 1001, title: 'E2E Test PBI Alpha', type: 'Product Backlog Item', state: 'Active', dueDate: null },
  { id: 1002, title: 'E2E Test PBI Beta', type: 'Product Backlog Item', state: 'Active', dueDate: null },
  { id: 1003, title: 'E2E Test Feature', type: 'Feature', state: 'Active', dueDate: null },
];

/**
 * Map the terse StubWorkItem shape used in tests to the full WorkItem contract
 * the client expects from `GET /api/workitems` — see src/client/types/workitem.ts.
 * The client maps `type` → `workItemType` and reads `changedDate`/`createdDate`,
 * `areaPath`, and `iterationPath`, so those must be present.
 */
function toClientWorkItem(stub: StubWorkItem): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: stub.id,
    title: stub.title,
    state: stub.state,
    workItemType: stub.type,
    assignedTo: stub.assignedTo,
    // Client treats absent due/target dates as "unscheduled"; null → omit.
    dueDate: stub.dueDate ?? undefined,
    targetDate: stub.targetDate ?? undefined,
    areaPath: stub.areaPath ?? 'MaxView',
    iterationPath: stub.iterationPath ?? 'MaxView',
    changedDate: now,
    createdDate: now,
    parentId: stub.parentId,
  };
}

/**
 * Stub the ADO work-item listing and PATCH calls so the Calendar can render
 * without real Azure DevOps credentials.
 */
export async function stubAdoWorkItems(
  page: Page,
  items: StubWorkItem[] = DEFAULT_WORK_ITEMS,
): Promise<void> {
  // GET /api/workitems — the client (workItemService.getWorkItems) consumes the
  // JSON body directly as a WorkItem[] array, NOT a { items, totalCount } object.
  await page.route('**/api/workitems*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(items.map(toClientWorkItem)),
    });
  });

  // PATCH /api/workitems/:id — simulates a successful due-date update
  await page.route('**/api/workitems/**', (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, ...body }),
      });
    } else {
      route.continue();
    }
  });
}

/**
 * Stub the ADO projects list so the project selector always shows a test project.
 */
export async function stubAdoProjects(
  page: Page,
  projects: Array<{ id: string; name: string }> = [
    { id: 'e2e-project-id', name: 'MaxView' },
    { id: 'e2e-project-id-2', name: 'MatterWorx' },
  ],
): Promise<void> {
  await page.route('**/api/projects', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(projects.map((p) => ({ ...p, description: '' }))),
      });
    } else {
      route.continue();
    }
  });
}

// ── SSE / AI stubs ────────────────────────────────────────────────────────────

/**
 * Suppress SSE notification streams so tests don't hang on an open connection.
 */
export async function suppressSseStreams(page: Page): Promise<void> {
  await page.route('**/api/notifications/stream', (route) => {
    // Return an empty SSE response that closes immediately.
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body: '',
    });
  });
}

// ── Feature-flag stubs ──────────────────────────────────────────────────────

/**
 * Force the `beta-to-prod-announcement` flag OFF so the blocking "Welcome to
 * Apex Production" modal (src/client/components/BetaAnnouncementModal.tsx) never
 * renders for the non–super-admin SSO test account on deployed dev/staging.
 *
 * For a non-admin that modal has no dismiss button and locks the page (body
 * overflow hidden), which would block authenticated `@deployed-smoke` journeys.
 *
 * The client fetches `GET /api/feature-flags/evaluate?project=<project>` and
 * reads `flags['beta-to-prod-announcement']` (see useFeatureFlags.ts). We fetch
 * the REAL evaluated flags first and flip only that one key to false, preserving
 * every other genuine flag. If the real fetch fails (e.g. running locally where
 * the endpoint or host differs), we fall back to a minimal payload with just the
 * modal disabled. Locally the flag is off anyway, so this is a harmless no-op.
 */
export async function suppressBetaAnnouncement(page: Page): Promise<void> {
  await page.route('**/api/feature-flags/evaluate*', async (route) => {
    try {
      const response = await route.fetch();
      const data = (await response.json()) as EvaluateFlagsResponse;
      const patched: EvaluateFlagsResponse = {
        flags: { ...(data?.flags ?? {}), 'beta-to-prod-announcement': false },
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(patched),
      });
    } catch {
      // Real fetch unavailable/failed — never hang the test; disable just the modal.
      const fallback: EvaluateFlagsResponse = { flags: { 'beta-to-prod-announcement': false } };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fallback),
      });
    }
  });
}
