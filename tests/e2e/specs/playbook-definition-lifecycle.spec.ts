/**
 * @smoke
 * AC: PBI-006 (a), (c), (d)
 *
 * Critical thin-editor workflow for FEAT-007.
 */
import {
  test,
  expect,
  SeedApi,
  E2E_PROJECT,
  PERSONA_OIDS,
} from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';

test.describe('Playbook definition lifecycle @smoke', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('an author saves, publishes, retains the draft, and keeps version 1 current after another edit', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const fixture = await SeedApi.seedPlaybookLifecycle(e2eApi, {
      project: E2E_PROJECT,
      authorId: PERSONA_OIDS.ba,
      viewerId: PERSONA_OIDS.qa,
      name: `Lifecycle author smoke ${Date.now()}`,
    });

    await stubAdoProjects(page);
    await page.addInitScript((project) => {
      window.localStorage.setItem('selectedProject', project);
      window.localStorage.setItem('selectedAreaPath', project);
    }, E2E_PROJECT);
    await loginAsPersona('ba');
    await page.goto('/playbooks');

    await expect(page.getByTestId('playbook-definitions-panel')).toBeVisible();
    await page.getByTestId('playbook-definition-select').selectOption(fixture.definition.id);

    const editor = page.getByTestId('playbook-draft-editor');
    const savedGraph = JSON.stringify({
      nodes: [{ id: 'announce', stepType: 'notify', config: { title: 'published snapshot' } }],
      edges: [],
    }, null, 2);
    await editor.fill(savedGraph);
    await page.getByTestId('playbook-draft-save').click();
    await expect(page.getByTestId('playbook-definition-status')).toContainText('Draft saved');

    await page.getByTestId('playbook-draft-publish').click();
    await expect(page.getByTestId('playbook-version-current')).toContainText('Current');
    await expect(editor).toBeEditable();
    await expect(page.getByTestId('playbook-definition-status')).toContainText('Draft retained');

    await editor.fill(savedGraph.replace('published snapshot', 'edited after v1'));
    await page.getByTestId('playbook-draft-save').click();
    await expect(page.getByTestId('playbook-version-list')).toContainText('Version 1');
    await expect(page.getByTestId('playbook-version-current')).toContainText('Current');
  });

  test('a viewer sees definitions and history without lifecycle controls', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const fixture = await SeedApi.seedPlaybookLifecycle(e2eApi, {
      project: E2E_PROJECT,
      authorId: PERSONA_OIDS.ba,
      viewerId: PERSONA_OIDS.qa,
      name: `Lifecycle viewer smoke ${Date.now()}`,
      published: true,
    });

    await stubAdoProjects(page);
    await page.addInitScript((project) => {
      window.localStorage.setItem('selectedProject', project);
      window.localStorage.setItem('selectedAreaPath', project);
    }, E2E_PROJECT);
    await loginAsPersona('qa');
    await page.goto('/playbooks');

    await expect(page.getByTestId('playbook-definition-select')).toBeVisible();
    await page.getByTestId('playbook-definition-select').selectOption(fixture.definition.id);
    await expect(page.getByTestId('playbook-version-list')).toBeVisible();
    await expect(page.getByTestId('playbook-definition-create')).toHaveCount(0);
    await expect(page.getByTestId('playbook-draft-save')).toHaveCount(0);
    await expect(page.getByTestId('playbook-draft-publish')).toHaveCount(0);
    await expect(page.getByTestId('playbook-version-deprecate')).toHaveCount(0);
  });
});
