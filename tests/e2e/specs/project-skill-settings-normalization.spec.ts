/**
 * Per-workflow project skill settings after the expand step
 * (design-docs/project-skill-settings-normalization.plan.md, steps 1-3).
 *
 * Admin > Project Settings still reads and writes the flat ProjectSkillConfig
 * shape. The server mirrors each saved workflow into
 * project_skill_workflow_settings and prefers those rows on read, falling back
 * to the legacy flat columns when a workflow has no child row.
 *
 * SeedApi.seedAdminRole gives the manager persona admin:roles; reset() removes it.
 */
import type { Page } from '@playwright/test';
import { test, expect, SeedApi, PERSONA_OIDS, E2E_PROJECT } from '../support/fixtures';
import { stubAdoProjects, stubAllAiTraffic } from '../support/api-stubs';
import { AdminProjectSettingsPage } from '../pages/admin-project-settings.page';

test.use({ video: 'on' });

const MODELS = [
  { id: 'e2e-model-alpha', displayName: 'E2E Model Alpha' },
  { id: 'e2e-model-beta', displayName: 'E2E Model Beta' },
  { id: 'e2e-model-gamma', displayName: 'E2E Model Gamma' },
  { id: 'e2e-model-default', displayName: 'E2E Default Model' },
];
const BEDROCK_MODELS = [
  { id: 'e2e.bedrock-alpha', label: 'E2E Bedrock Alpha' },
  { id: 'e2e.bedrock-beta', label: 'E2E Bedrock Beta' },
];
const SKILL_REPO = 'E2E/skills';
const SKILLS = [
  { id: 'prd-alt', name: 'PRD Alt', description: '', path: '.cursor/skills/prd-alt/SKILL.md' },
  { id: 'prd-legacy', name: 'PRD Legacy', description: '', path: '.cursor/skills/prd-legacy/SKILL.md' },
  { id: 'design-alt', name: 'Design Alt', description: '', path: '.cursor/skills/design-alt/SKILL.md' },
];

type FlatConfig = Record<string, unknown> & { id: string };
type WorkflowRow = Record<string, unknown> & { workflow: string };

async function stubSettingsLookups(page: Page): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route('**/api/available-models', (route) => route.fulfill(json({ models: MODELS })));
  await page.route('**/api/admin/available-bedrock-models', (route) =>
    route.fulfill(json({ models: BEDROCK_MODELS })),
  );
  await page.route('**/api/skills/repos?**', (route) =>
    route.fulfill(json([{ id: SKILL_REPO, name: SKILL_REPO, defaultBranch: 'main' }])),
  );
  await page.route('**/api/skills/branches?**', (route) => route.fulfill(json(['main'])));
  await page.route('**/api/skills/list?**', (route) => route.fulfill(json(SKILLS)));
  await page.route('**/api/skills/refresh?**', (route) => route.fulfill(json({ ok: true })));
}

/** A fixed caption burned into the recorded video for each scenario step. */
async function caption(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    let el = document.getElementById('e2e-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'e2e-caption';
      el.setAttribute(
        'style',
        [
          'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
          'padding:10px 16px', 'background:rgba(17,24,39,0.88)', 'color:#fff',
          'font:600 15px/1.4 system-ui,sans-serif', 'pointer-events:none',
        ].join(';'),
      );
      document.body.appendChild(el);
    }
    el.textContent = value;
  }, text);
}

async function openAdmin(page: Page, loginAsPersona: (p: 'manager') => Promise<void>) {
  await stubAdoProjects(page);
  await stubAllAiTraffic(page);
  await stubSettingsLookups(page);
  await page.addInitScript((project) => {
    localStorage.setItem('selectedProject', project);
  }, E2E_PROJECT);
  await loginAsPersona('manager');
  const settings = new AdminProjectSettingsPage(page);
  await settings.goto();
  await expect(page).toHaveURL(/\/admin\/project-settings/);
  return settings;
}

async function openConfig(page: Page, settings: AdminProjectSettingsPage, id: string, text: string) {
  await settings.goto();
  await settings.editConfig(id);
  await expect(page.getByTestId('ps-stage-model-prdModel')).toBeEnabled();
  await expect(page.getByTestId('ps-stage-skill-prdSkillPath')).toBeEnabled();
  await caption(page, text);
}

async function saveConfig(page: Page, settings: AdminProjectSettingsPage, id: string) {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT'
      && response.url().endsWith(`/api/admin/project-settings/${id}`),
  );
  await settings.save();
  expect((await saved).status()).toBe(200);
}

/**
 * The flat config the interview, ADR and other client consumers receive. It is a
 * public subset: Bedrock fields and defaultModel come from adminConfig instead.
 */
async function consumerConfig(page: Page, id: string): Promise<FlatConfig> {
  const res = await page.request.get(
    `/api/skill-config?project=${encodeURIComponent(E2E_PROJECT)}&settingsId=${encodeURIComponent(id)}`,
  );
  expect(res.status()).toBe(200);
  return (await res.json()) as FlatConfig;
}

async function adminConfig(page: Page, id: string): Promise<FlatConfig> {
  const res = await page.request.get('/api/admin/project-settings');
  expect(res.status()).toBe(200);
  const config = ((await res.json()) as FlatConfig[]).find((c) => c.id === id);
  expect(config).toBeDefined();
  return config!;
}

function byWorkflow(rows: WorkflowRow[]): Record<string, WorkflowRow> {
  return Object.fromEntries(rows.map((row) => [row.workflow, row]));
}

async function expandAccordion(page: Page, slug: string): Promise<void> {
  const toggle = page.getByTestId(`ps-accordion-toggle-${slug}`);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

test.describe('Project skill settings normalization @project-settings', () => {
  test.beforeEach(async ({ e2eApi }) => {
    await SeedApi.seedAdminRole(e2eApi, { userId: PERSONA_OIDS.manager });
  });

  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('(a) per-workflow skill, model, effort and Bedrock settings read back identically after reload', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const config = await SeedApi.seedProjectSettings(e2eApi, {
      project: E2E_PROJECT,
      friendlyName: 'Normalization Save',
      isDefault: true,
      skillRepo: SKILL_REPO,
    });
    const settings = await openAdmin(page, loginAsPersona);
    await openConfig(page, settings, config.id, '(a) Admin sets PRD skill, model, effort and Bedrock settings');

    await page.getByTestId('ps-stage-skill-prdSkillPath').selectOption(SKILLS[0].path);
    await page.getByTestId('ps-stage-model-prdModel').selectOption('e2e-model-alpha');
    await page.getByTestId('ps-stage-effort-prdEffort').selectOption('high');
    await expandAccordion(page, 'apex-bedrock-models');
    await page.getByTestId('ps-bedrock-model').selectOption('e2e.bedrock-beta');
    await page.getByTestId('ps-bedrock-max-tokens').selectOption('32000');
    await page.getByTestId('ps-ui-lab-temperature').selectOption('0.7');
    await saveConfig(page, settings, config.id);

    await page.reload();
    await openConfig(page, settings, config.id, '(a) After reload the same values read back');
    await expect(page.getByTestId('ps-stage-skill-prdSkillPath')).toHaveValue(SKILLS[0].path);
    await expect(page.getByTestId('ps-stage-model-prdModel')).toHaveValue('e2e-model-alpha');
    await expect(page.getByTestId('ps-stage-effort-prdEffort')).toHaveValue('high');
    await expandAccordion(page, 'apex-bedrock-models');
    await expect(page.getByTestId('ps-bedrock-model')).toHaveValue('e2e.bedrock-beta');
    await expect(page.getByTestId('ps-bedrock-max-tokens')).toHaveValue('32000');
    await expect(page.getByTestId('ps-ui-lab-temperature')).toHaveValue('0.7');

    expect(await consumerConfig(page, config.id)).toEqual(expect.objectContaining({
      prdSkillPath: SKILLS[0].path,
      prdModel: 'e2e-model-alpha',
      prdEffort: 'high',
    }));
    expect(await adminConfig(page, config.id)).toEqual(expect.objectContaining({
      prdReviewBedrockModelId: 'e2e.bedrock-beta',
      prdReviewBedrockMaxTokens: 32000,
      uiLabBedrockTemperature: 0.7,
    }));

    const rows = byWorkflow(await SeedApi.inspectWorkflowSettings(e2eApi, config.id));
    expect(rows.prd).toEqual(expect.objectContaining({
      skillPath: SKILLS[0].path,
      model: 'e2e-model-alpha',
      effort: 'high',
    }));
    expect(rows.prd_review).toEqual(expect.objectContaining({
      bedrockModelId: 'e2e.bedrock-beta',
      bedrockMaxTokens: 32000,
    }));
    expect(rows.ui_lab?.bedrockTemperature).toBeCloseTo(0.7);
    await caption(page, '(a) Passed: UI, consumer API and child rows agree');
  });

  test('(b) workflow values stored in the child table display and resolve', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const config = await SeedApi.seedProjectSettings(e2eApi, {
      project: E2E_PROJECT,
      friendlyName: 'Normalization Legacy',
      isDefault: true,
      skillRepo: SKILL_REPO,
      legacyWorkflowValues: {
        prdSkillPath: SKILLS[1].path,
        prdModel: 'e2e-model-beta',
        prdEffort: 'medium',
        prdReviewBedrockModelId: 'e2e.bedrock-alpha',
        prdReviewBedrockMaxTokens: 64000,
      },
    });
    const seeded = byWorkflow(await SeedApi.inspectWorkflowSettings(e2eApi, config.id));
    expect(seeded.prd).toEqual(expect.objectContaining({
      skillPath: SKILLS[1].path,
      model: 'e2e-model-beta',
      effort: 'medium',
    }));
    expect(seeded.prd_review).toEqual(expect.objectContaining({
      bedrockModelId: 'e2e.bedrock-alpha',
      bedrockMaxTokens: 64000,
    }));

    const settings = await openAdmin(page, loginAsPersona);
    await openConfig(page, settings, config.id, '(b) Child-table values open in the admin form');
    await expect(page.getByTestId('ps-stage-skill-prdSkillPath')).toHaveValue(SKILLS[1].path);
    await expect(page.getByTestId('ps-stage-model-prdModel')).toHaveValue('e2e-model-beta');
    await expect(page.getByTestId('ps-stage-effort-prdEffort')).toHaveValue('medium');
    await expandAccordion(page, 'apex-bedrock-models');
    await expect(page.getByTestId('ps-bedrock-model')).toHaveValue('e2e.bedrock-alpha');
    await expect(page.getByTestId('ps-bedrock-max-tokens')).toHaveValue('64000');

    expect(await consumerConfig(page, config.id)).toEqual(expect.objectContaining({
      prdSkillPath: SKILLS[1].path,
      prdModel: 'e2e-model-beta',
      prdEffort: 'medium',
    }));
    expect(await adminConfig(page, config.id)).toEqual(expect.objectContaining({
      prdReviewBedrockModelId: 'e2e.bedrock-alpha',
      prdReviewBedrockMaxTokens: 64000,
    }));
    await caption(page, '(b) Passed: child-table values display and reach consumers');
  });

  test('(c) a workflow with no override falls back to default_model and default_effort', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const config = await SeedApi.seedProjectSettings(e2eApi, {
      project: E2E_PROJECT,
      friendlyName: 'Normalization Defaults',
      isDefault: true,
      skillRepo: SKILL_REPO,
      defaultModel: 'e2e-model-default',
      defaultEffort: 'low',
      legacyWorkflowValues: { prdModel: 'e2e-model-alpha' },
    });
    const settings = await openAdmin(page, loginAsPersona);
    await openConfig(page, settings, config.id, '(c) Design Doc has no override, so it uses the project default');

    await expect(page.getByTestId('ps-defaultModel')).toHaveValue('e2e-model-default');
    await expect(page.getByTestId('ps-defaultEffort')).toHaveValue('low');
    await expect(page.getByTestId('ps-stage-model-designDocModel')).toHaveValue('');
    await expect(page.getByTestId('ps-stage-effort-designDocEffort')).toHaveValue('');
    await expect(
      page.getByTestId('ps-stage-designDocSkillPath').getByText('Using: E2E Default Model'),
    ).toBeVisible();

    await saveConfig(page, settings, config.id);
    const flat = await consumerConfig(page, config.id);
    expect(flat.designDocModel ?? null).toBeNull();
    expect(flat.designDocEffort ?? null).toBeNull();
    expect(flat).toEqual(expect.objectContaining({
      defaultEffort: 'low',
      prdModel: 'e2e-model-alpha',
    }));
    expect((await adminConfig(page, config.id)).defaultModel).toBe('e2e-model-default');
    const rows = byWorkflow(await SeedApi.inspectWorkflowSettings(e2eApi, config.id));
    expect(rows.design_doc).toBeUndefined();
    expect(rows.prd?.model).toBe('e2e-model-alpha');
    await caption(page, '(c) Passed: no design_doc child row; consumers fall back to the defaults');
  });

  test('(d) editing one workflow does not overwrite another', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const config = await SeedApi.seedProjectSettings(e2eApi, {
      project: E2E_PROJECT,
      friendlyName: 'Normalization Isolation',
      isDefault: true,
      skillRepo: SKILL_REPO,
      legacyWorkflowValues: {
        prdModel: 'e2e-model-beta',
        prdEffort: 'high',
        designDocModel: 'e2e-model-alpha',
        designDocEffort: 'low',
      },
    });
    const settings = await openAdmin(page, loginAsPersona);
    await openConfig(page, settings, config.id, '(d) Change only the Design Doc model and effort');
    await page.getByTestId('ps-stage-model-designDocModel').selectOption('e2e-model-gamma');
    await page.getByTestId('ps-stage-effort-designDocEffort').selectOption('medium');
    await saveConfig(page, settings, config.id);

    await page.reload();
    await openConfig(page, settings, config.id, '(d) PRD keeps its own model and effort');
    await expect(page.getByTestId('ps-stage-model-designDocModel')).toHaveValue('e2e-model-gamma');
    await expect(page.getByTestId('ps-stage-effort-designDocEffort')).toHaveValue('medium');
    await expect(page.getByTestId('ps-stage-model-prdModel')).toHaveValue('e2e-model-beta');
    await expect(page.getByTestId('ps-stage-effort-prdEffort')).toHaveValue('high');

    const rows = byWorkflow(await SeedApi.inspectWorkflowSettings(e2eApi, config.id));
    expect(rows.design_doc).toEqual(expect.objectContaining({ model: 'e2e-model-gamma', effort: 'medium' }));
    expect(rows.prd).toEqual(expect.objectContaining({ model: 'e2e-model-beta', effort: 'high' }));
    expect(await adminConfig(page, config.id)).toEqual(expect.objectContaining({
      prdModel: 'e2e-model-beta',
      prdEffort: 'high',
      designDocModel: 'e2e-model-gamma',
      designDocEffort: 'medium',
    }));
    await caption(page, '(d) Passed: design_doc changed, prd untouched');
  });

  test('(e) the three ADR workflows each read back the shared ADR model and effort', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const config = await SeedApi.seedProjectSettings(e2eApi, {
      project: E2E_PROJECT,
      friendlyName: 'Normalization ADR',
      isDefault: true,
      skillRepo: SKILL_REPO,
      legacyWorkflowValues: { adrModel: 'e2e-model-beta', adrEffort: 'medium' },
    });
    const settings = await openAdmin(page, loginAsPersona);
    await openConfig(page, settings, config.id, '(e) Pre-existing shared ADR model and effort show in the form');
    await expandAccordion(page, 'document-pipeline-adr');
    await expect(page.getByTestId('ps-adrModel')).toHaveValue('e2e-model-beta');
    await expect(page.getByTestId('ps-adrEffort')).toHaveValue('medium');

    await caption(page, '(e) Save without changes: the shared values fan out to the three ADR workflows');
    await saveConfig(page, settings, config.id);
    const rows = byWorkflow(await SeedApi.inspectWorkflowSettings(e2eApi, config.id));
    for (const workflow of ['adr_interview', 'adr_finalize', 'adr_assistant']) {
      expect(rows[workflow]).toEqual(expect.objectContaining({ model: 'e2e-model-beta', effort: 'medium' }));
    }

    await page.reload();
    await openConfig(page, settings, config.id, '(e) After reload the ADR model and effort are unchanged');
    await expandAccordion(page, 'document-pipeline-adr');
    await expect(page.getByTestId('ps-adrModel')).toHaveValue('e2e-model-beta');
    await expect(page.getByTestId('ps-adrEffort')).toHaveValue('medium');
    expect(await consumerConfig(page, config.id)).toEqual(expect.objectContaining({
      adrModel: 'e2e-model-beta',
      adrEffort: 'medium',
    }));
    await caption(page, '(e) Passed: adr_interview, adr_finalize and adr_assistant share the ADR values');
  });
});
