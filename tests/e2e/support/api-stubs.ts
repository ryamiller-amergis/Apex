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

// ── AI / Bedrock interception stubs ─────────────────────────────────────────

const CANNED_SSE = [
  'event: status\ndata: {"status":"running"}\n\n',
  'event: assistant\ndata: {"text":"E2E canned assistant reply."}\n\n',
  'event: done\ndata: {"status":"idle"}\n\n',
].join('');

/**
 * Stub chat SSE streams so interview / assistant threads never hit Cursor/Bedrock.
 */
export async function stubAiChatStream(page: Page): Promise<void> {
  await page.route('**/api/chat/threads/*/stream*', (route) => {
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body: CANNED_SSE,
    });
  });

  await page.route('**/api/chat/threads/*/messages', (route) => {
    if (route.request().method() === 'POST') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, status: 'running' }),
      });
    } else {
      route.continue();
    }
  });

  await page.route('**/api/ask-apex/sessions/*/stream*', (route) => {
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body: CANNED_SSE,
    });
  });
}

/**
 * Short-circuit PRD generation from a completed interview.
 * Returns a canned PRD id so navigation can proceed.
 * Prefer passing a real seeded PRD id so the destination page loads.
 */
export async function stubPrdGeneration(
  page: Page,
  cannedPrd?: { id: string; title?: string; status?: string; prdId?: string },
): Promise<void> {
  const prdId = cannedPrd?.prdId ?? cannedPrd?.id ?? '00000000-0000-4000-8000-0000000000e2';
  const body = {
    prdId,
    id: prdId,
    title: cannedPrd?.title ?? '[E2E] Generated PRD',
    status: cannedPrd?.status ?? 'draft',
  };

  // POST /api/chat/threads — startChat for PRD generation thread
  await page.route('**/api/chat/threads', (route) => {
    if (route.request().method() === 'POST') {
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          threadId: '00000000-0000-4000-8000-0000000000c1',
          id: '00000000-0000-4000-8000-0000000000c1',
        }),
      });
    } else {
      route.continue();
    }
  });

  // POST /api/interviews/:interviewId/prds
  await page.route('**/api/interviews/*/prds', (route) => {
    if (route.request().method() === 'POST') {
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    } else {
      route.continue();
    }
  });
}

/**
 * Short-circuit prototype generation / regeneration.
 */
export async function stubPrototypeGeneration(page: Page): Promise<void> {
  await page.route('**/api/design-prototypes/**/generate*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, status: 'generating' }),
    });
  });

  await page.route('**/api/design-prototypes/*/regenerate*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-proto',
        status: 'regenerating',
        mockHtml: '<html><body><h1>E2E Regenerated</h1></body></html>',
      }),
    });
  });
}

/**
 * Stub validation scorecard endpoints (PRD + design doc) with a chosen score.
 */
export async function stubValidationScorecard(
  page: Page,
  score = 95,
  threshold = 90,
): Promise<void> {
  const scorecard = {
    slug: 'e2e-scorecard',
    generated_at: new Date().toISOString(),
    review_phase: 'final',
    overall_score: score,
    ready_threshold: threshold,
    is_ready: score >= threshold,
    verdict: score >= threshold ? 'ready' : 'gaps',
    features: [],
    files: [],
  };

  await page.route('**/api/interviews/**/validation*', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ scorecard, reportMd: `# Score ${score}` }),
      });
    } else {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, validationScore: score, validationScorecard: scorecard }),
      });
    }
  });
}

const DEFAULT_PROPOSED_CONTENT =
  '# E2E Fixed Document\n\nThis content was produced by a canned Fix-with-AI stub.';

/**
 * Stub Fix-with-AI / Fix-comment endpoints so proposed-changes UI can render
 * without calling Bedrock. Also persists proposed content via /e2e seed PATCH
 * so the client refetch after mutation sees real proposal fields.
 */
export async function stubFixWithAi(
  page: Page,
  opts?: { proposedContent?: string },
): Promise<void> {
  const proposedContent = opts?.proposedContent ?? DEFAULT_PROPOSED_CONTENT;

  const persistAndFulfill = async (
    route: {
      request: () => { url: () => string; method: () => string };
      fulfill: (opts: Record<string, unknown>) => Promise<void>;
    },
  ) => {
    const url = route.request().url();
    const prdMatch = url.match(/\/prds\/([^/?]+)\/fix-/);
    const docMatch = url.match(/\/design-docs\/([^/?]+)\/fix-/);

    try {
      if (prdMatch?.[1]) {
        await page.request.patch(`http://127.0.0.1:3001/e2e/seed/prd/${prdMatch[1]}`, {
          data: { proposedContent },
        });
      } else if (docMatch?.[1]) {
        // Design-doc proposed fields are applied via the real mutation path when
        // unstubbed; for stubs, fulfill ok and let the UI show Accept/Reject from
        // a subsequent seed if needed. Prefer PRD comment-fix coverage here.
      }
    } catch {
      // Non-fatal — assertion may still pass on button aria-label alone.
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        proposedContent,
        proposedBacklogJson: null,
        proposedDesignContent: proposedContent,
        proposedTechSpecContent: proposedContent,
        proposedAssumptionsContent: proposedContent,
      }),
    });
  };

  await page.route('**/api/interviews/prds/*/fix-with-ai*', (route) => {
    void persistAndFulfill(route);
  });
  await page.route('**/api/interviews/prds/*/fix-comment-with-ai*', (route) => {
    void persistAndFulfill(route);
  });
  await page.route('**/api/interviews/design-docs/*/fix-with-ai*', (route) => {
    void persistAndFulfill(route);
  });
  await page.route('**/api/interviews/design-docs/*/fix-comment-with-ai*', (route) => {
    void persistAndFulfill(route);
  });
  await page.route('**/api/interviews/**/fix-validation*', (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, threadId: '00000000-0000-4000-8000-0000000000f1' }),
    });
  });
}

/** Alias for comment-scoped fix stubs. */
export async function stubFixComment(
  page: Page,
  opts?: { proposedContent?: string },
): Promise<void> {
  await stubFixWithAi(page, opts);
}

/**
 * Catch-all Bedrock / Cursor agent traffic so no real tokens are consumed.
 * Prefer the more specific stubs above when asserting response shape.
 */
export async function stubBedrock(page: Page): Promise<void> {
  await page.route('**/bedrock**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, stubbed: true }),
    });
  });
  await page.route('**/api.anthropic.com/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, stubbed: true }),
    });
  });
  await page.route('**/api2.cursor.sh/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, stubbed: true }),
    });
  });
}

/**
 * Convenience: apply the full AI-interception set used by @interview-flow specs.
 */
export async function stubAllAiTraffic(page: Page): Promise<void> {
  await suppressSseStreams(page);
  await stubAiChatStream(page);
  await stubPrdGeneration(page);
  await stubPrototypeGeneration(page);
  await stubValidationScorecard(page);
  await stubFixWithAi(page);
  await stubBedrock(page);
}
