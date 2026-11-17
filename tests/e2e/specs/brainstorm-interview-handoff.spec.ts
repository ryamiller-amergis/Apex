/**
 * Brainstorm → Start Interview handoff.
 *
 * A: Start Interview opens the new interview page with the brainstorm prefilled and
 *    staged as linked context; the created interview is usable at once, lists the
 *    brainstorm in Linked Context, and the session shows "Open" for it.
 * B: an in-progress interview whose thread is empty and idle opens with a usable
 *    composer instead of a permanent "Pinning…" state.
 * C: the same handoff against a real model. The reply must quote a token that only
 *    exists in the linked brainstorm artifact. Skipped when no model is reachable.
 *
 * A and B stub only the first-message POST, so no model runs and the thread stays
 * empty and idle — the state that used to show "Pinning…" forever.
 */
import type { Page } from '@playwright/test';
import { expect, test, E2E_PROJECT, PERSONA_OIDS, SeedApi } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';
import { DEFAULT_ENABLED_MENU_VIEWS } from '../../../src/shared/types/menuSettings';

test.use({ video: 'on' });

const OWNER = PERSONA_OIDS['product-owner'];
const ZEBRA_TOKEN = 'E2E-LINKED-ZEBRA-42';
const ARTIFACT_TITLE = 'Queue worker design';
const ARTIFACT = `# ${ARTIFACT_TITLE}

## Context

Document jobs pile up during month-end close. Reference token: ${ZEBRA_TOKEN}.

## Proposed design

Workers poll a Service Bus queue and write results to Blob storage.`;
const REAL_MODEL = 'composer-2';
const REAL_PROMPT = 'Validate the linked context. Reply with a short summary of what is linked.';

async function selectProject(page: Page, project: string): Promise<void> {
  await page.addInitScript((p) => {
    window.localStorage.setItem('selectedProject', p);
    window.localStorage.setItem('selectedAreaPath', p);
  }, project);
}

async function stubFirstMessage(page: Page): Promise<void> {
  await page.route('**/api/chat/threads/*/messages', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    } else {
      await route.fallback();
    }
  });
}

const GRILL_DESIGN_PATH = '.cursor/skills/grill-design/SKILL.md';

/** The E2E skill repository has no files on disk, so list the two interview skills the page chooses between. */
async function stubInterviewSkills(page: Page): Promise<void> {
  await page.route('**/api/skills/list*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 'grill-with-docs', name: 'grill-with-docs', description: 'Feature interview', path: '.cursor/skills/grill-with-docs/SKILL.md' },
        { id: 'grill-design', name: 'grill-design', description: 'Technical design interview', path: GRILL_DESIGN_PATH },
      ]),
    });
  });
}

async function selectOwner(page: Page, inputTestId: string, required = true): Promise<void> {
  const input = page.getByTestId(inputTestId);
  if (!required && !(await input.isVisible().catch(() => false))) return;
  await expect(input).toBeVisible();
  await input.fill('Product Owner Dev User');
  await input.press('ArrowDown');
  await input.press('Enter');
}

/** Owners are not under test here: the logged-in author owns both documents and nobody reviews. */
async function confirmOwners(page: Page): Promise<void> {
  await expect(page.getByTestId('section-owner-modal')).toBeVisible();
  await selectOwner(page, 'so-prd-owner-input');
  await selectOwner(page, 'so-dd-owner-input');
  await selectOwner(page, 'so-qa-owner-input', false);
  await page.getByTestId('confirm-start-interview-no-reviewers').click();
}

async function seedBrainstorm(request: Parameters<typeof SeedApi.reset>[0]): Promise<string> {
  const { id } = await SeedApi.seedBrainstormSession(request, {
    project: E2E_PROJECT,
    creatorId: OWNER,
    title: 'Queue worker brainstorm',
  });
  await SeedApi.seedBrainstormArtifact(request, { sessionId: id, type: 'technical_design', versions: [ARTIFACT] });
  return id;
}

/** From the brainstorm workspace, through the prefilled compose page, to the new interview. */
async function startInterviewFromBrainstorm(page: Page, sessionId: string, opts: { model?: string; prompt?: string } = {}): Promise<string> {
  await page.goto(`/brainstorm/${sessionId}`);
  await expect(page.getByTestId('brainstorm-artifact-body')).toContainText(ARTIFACT_TITLE);
  const start = page.getByTestId('brainstorm-action-start-start-interview');
  await expect(start).toBeVisible({ timeout: 15_000 });
  await expect(start).not.toHaveAttribute('aria-disabled', 'true');
  await start.click();

  await expect(page).toHaveURL(new RegExp(`/backlog/interview/new\\?brainstormSessionId=${sessionId}$`));
  await expect(page.getByTestId('interview-compose-title')).toHaveValue(ARTIFACT_TITLE, { timeout: 15_000 });
  await expect(page.getByTestId('interview-compose-brainstorm-chip')).toContainText(ARTIFACT_TITLE);
  await expect(page.getByTestId('interview-compose-linked-context-count')).toHaveText('1');
  await expect(page.getByTestId('interview-compose-message')).not.toHaveValue('');

  await page.getByTestId('interview-compose-title').fill(`[E2E] ${ARTIFACT_TITLE}`);
  if (opts.model) await page.getByTestId('interview-compose-model').selectOption(opts.model);
  if (opts.prompt) await page.getByTestId('interview-compose-message').fill(opts.prompt);

  const submit = page.getByTestId('interview-compose-start');
  await expect(submit).toBeEnabled({ timeout: 15_000 });
  await submit.click();
  await confirmOwners(page);
  await expect(page).toHaveURL(/\/backlog\/interview\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  return new URL(page.url()).pathname.split('/').pop()!;
}

test.describe('Brainstorm → Start Interview handoff @brainstorm @interview-flow', () => {
  test.beforeEach(async ({ page, request }) => {
    await SeedApi.setMenuSettings(request, E2E_PROJECT, [...DEFAULT_ENABLED_MENU_VIEWS]);
    await SeedApi.setBrainstormFlag(request, { enabled: true, projects: [E2E_PROJECT] });
    await SeedApi.seedProjectSettings(request, {
      project: E2E_PROJECT,
      isDefault: true,
      approvalMode: 'any_one',
      prototypeStageEnabled: false,
      testCaseSkillPath: null,
    });
    await stubAdoProjects(page);
    await selectProject(page, E2E_PROJECT);
  });

  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test.afterAll(async ({ request }) => {
    await SeedApi.setBrainstormFlag(request, { enabled: false, projects: [] });
  });

  test('A: Start Interview prefills the new interview page and links the brainstorm', async ({ page, request, loginAsPersona }) => {
    await stubFirstMessage(page);
    await stubInterviewSkills(page);
    await loginAsPersona('product-owner');
    const sessionId = await seedBrainstorm(request);

    const threadRequest = page.waitForRequest((req) =>
      req.method() === 'POST' && new URL(req.url()).pathname === '/api/chat/threads',
    );
    const interviewId = await startInterviewFromBrainstorm(page, sessionId);
    expect((await threadRequest).postDataJSON()).toEqual(expect.objectContaining({
      kickoff: expect.objectContaining({ skillPath: GRILL_DESIGN_PATH }),
    }));

    await expect(page.getByTestId('interview-preparation-state')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText('Pinning…')).toHaveCount(0);
    await expect(page.getByTestId('interview-message-input')).toBeEnabled();

    await page.getByTestId('interview-linked-context-trigger').click();
    const panel = page.getByTestId('interview-linked-context-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId(`linked-context-link-brainstorm-${sessionId}`)).toContainText(ARTIFACT_TITLE);
    await panel.press('Escape');

    await page.goto(`/brainstorm/${sessionId}`);
    const open = page.getByTestId('brainstorm-action-result-start-interview');
    await expect(open).toHaveText('Open', { timeout: 15_000 });
    await expect(open).toHaveAttribute('href', `/backlog/interview/${interviewId}`);
  });

  test('B: an in-progress interview with an empty idle thread has a usable composer', async ({ page, request, loginAsPersona }) => {
    await loginAsPersona('product-owner');
    const interview = await SeedApi.seedInterview(request, {
      authorId: OWNER,
      project: E2E_PROJECT,
      title: 'Empty idle thread',
      status: 'in_progress',
    });

    await page.goto(`/backlog/interview/${interview.id}`);
    await expect(page.getByTestId('interview-title')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('interview-preparation-state')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId('interview-message-input')).toBeEnabled();
    await page.getByTestId('interview-message-input').fill('Hello');
    await expect(page.getByTestId('interview-send-message')).toBeEnabled();
  });

  test('C: a real model reads the linked brainstorm artifact', async ({ page, request, loginAsPersona }, testInfo) => {
    const reason = 'CURSOR_API_KEY is not set, so the E2E server cannot run a real agent turn';
    if (!process.env.CURSOR_API_KEY) console.log(`[brainstorm-interview-handoff] Test C skipped: ${reason}`);
    test.skip(!process.env.CURSOR_API_KEY, reason);
    test.setTimeout(300_000);

    await loginAsPersona('product-owner');
    const sessionId = await seedBrainstorm(request);
    await startInterviewFromBrainstorm(page, sessionId, { model: REAL_MODEL, prompt: REAL_PROMPT });

    const reply = page.getByText(ZEBRA_TOKEN).last();
    await expect(reply).toBeVisible({ timeout: 240_000 });
    const replyText = (await reply.textContent()) ?? '';
    console.log(`[brainstorm-interview-handoff] Test C model=${REAL_MODEL} reply: ${replyText}`);
    await page.screenshot({ path: testInfo.outputPath('test-c-real-model-reply.png'), fullPage: true });
    expect(replyText).toContain(ZEBRA_TOKEN);
  });
});
