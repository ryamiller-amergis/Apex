/**
 * Project integrations journey.
 * Provider HTTP and the answer are stubbed. No live Clerk, Pendo, SendGrid, or model call.
 */
import { test, expect, SeedApi, E2E_PROJECT, PERSONA_OIDS } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';
import { SidebarPage } from '../pages/sidebar.page';
import { ProjectSelectorPage } from '../pages/project-selector.page';
import { IntegrationsPage } from '../pages/integrations.page';

const OTHER_PROJECT = 'MatterWorx';
const CONNECTION_NAME = '[E2E] MaxView Clerk';
const CREDENTIAL = 'sk_test_e2e_secret_99';
const QUESTION = 'What do we know about user jane@example.com from ticket 4421?';

test.use({ video: 'on' });

test.describe('project integrations', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.seedIntegrationsAccess(e2eApi, {
      enabled: false,
      projects: [E2E_PROJECT, OTHER_PROJECT],
      grants: [],
    }).catch(() => undefined);
    await SeedApi.reset(e2eApi);
  });

  test('hides the module, denies management, tests a connection, isolates projects, and answers from that connection', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');

    const selector = new ProjectSelectorPage(page);
    const sidebar = new SidebarPage(page);
    const integrations = new IntegrationsPage(page);

    await selector.goto();
    if (!page.url().includes('/home')) {
      await selector.selectProject(E2E_PROJECT);
    }
    await sidebar.waitForReady();

    await expect(integrations.navItem()).toHaveCount(0);
    const hidden = await page.request.get(`/api/projects/${encodeURIComponent(E2E_PROJECT)}/integrations`);
    expect(hidden.status()).toBe(404);

    await SeedApi.seedIntegrationProviderStub(e2eApi);
    await SeedApi.seedIntegrationsAccess(e2eApi, {
      enabled: true,
      projects: [E2E_PROJECT, OTHER_PROJECT],
      grants: [
        {
          userId: PERSONA_OIDS.developer,
          project: E2E_PROJECT,
          permissions: ['integrations:view'],
        },
        {
          userId: PERSONA_OIDS.manager,
          project: E2E_PROJECT,
          permissions: ['integrations:view', 'integrations:manage'],
        },
        {
          userId: PERSONA_OIDS.manager,
          project: OTHER_PROJECT,
          permissions: ['integrations:view', 'integrations:manage'],
        },
      ],
    });

    await page.reload();
    await sidebar.waitForReady();
    await expect(integrations.navItem()).toBeVisible();
    await integrations.open();
    await expect(page.getByTestId('integrations-create-form')).toHaveCount(0);

    const denied = await page.request.post(`/api/projects/${encodeURIComponent(E2E_PROJECT)}/integrations`, {
      data: {
        name: CONNECTION_NAME,
        provider: 'clerk',
        credential: CREDENTIAL,
        allowedUserIds: [PERSONA_OIDS.developer],
      },
    });
    expect(denied.status()).toBe(403);

    await loginAsPersona('manager');
    await selector.goto();
    if (!page.url().includes('/home')) {
      await selector.selectProject(E2E_PROJECT);
    }
    await sidebar.waitForReady();
    await integrations.open();
    await integrations.createClerk(CONNECTION_NAME, CREDENTIAL, PERSONA_OIDS.manager);

    const row = integrations.connectionRow(CONNECTION_NAME);
    await expect(row).toContainText('••••t_99');
    await expect(page.getByTestId('integrations-credential-input')).toHaveValue('');
    await expect(page.locator('body')).not.toContainText(CREDENTIAL);

    await row.getByRole('button', { name: 'Test' }).click();
    await expect(row).toContainText('Usable');

    await page.getByTestId('app-header-brand').click();
    await selector.waitForReady();
    await selector.selectProject(OTHER_PROJECT);
    await sidebar.waitForReady();
    await integrations.open();
    await expect(page.getByText(CONNECTION_NAME)).toHaveCount(0);
    await expect(page.getByTestId('integrations-empty')).toBeVisible();

    await page.getByTestId('app-header-brand').click();
    await selector.waitForReady();
    await selector.selectProject(E2E_PROJECT);
    await sidebar.waitForReady();
    await integrations.open();
    await integrations.ask(CONNECTION_NAME, QUESTION);
    await expect(page.getByTestId('integrations-answer')).toContainText('Jane Ticket');
    await expect(page.locator('body')).not.toContainText(CREDENTIAL);
  });
});
