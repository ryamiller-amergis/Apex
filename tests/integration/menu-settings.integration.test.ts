/**
 * Integration tests for project menu visibility.
 *
 * Verifies that menu-settings can be inserted, queried, and overridden via
 * the actual Drizzle ORM against the real projectMenuSettings table.
 */
import './setup';
import { db } from './setup';
import { projectMenuSettings } from '../../src/server/db/schema';
import type { MenuItemKey } from '../../src/shared/types/menuSettings';
import { eq } from 'drizzle-orm';

const TEST_PROJECT = 'E2EIntegrationTestProject';

async function cleanup() {
  await db.delete(projectMenuSettings).where(eq(projectMenuSettings.project, TEST_PROJECT));
}

describe('Project menu settings integration', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('inserts menu settings for a project', async () => {
    const views: MenuItemKey[] = ['calendar', 'planning'];
    await db
      .insert(projectMenuSettings)
      .values({
        project: TEST_PROJECT,
        enabledViews: views,
      });

    const [row] = await db
      .select()
      .from(projectMenuSettings)
      .where(eq(projectMenuSettings.project, TEST_PROJECT));

    expect(row.enabledViews).toEqual(views);
  });

  it('upserts new enabled views without creating a duplicate row', async () => {
    const initial: MenuItemKey[] = ['calendar'];
    await db
      .insert(projectMenuSettings)
      .values({ project: TEST_PROJECT, enabledViews: initial });

    const updated: MenuItemKey[] = ['calendar', 'backlog'];
    // Upsert with new enabled views.
    await db
      .insert(projectMenuSettings)
      .values({ project: TEST_PROJECT, enabledViews: updated })
      .onConflictDoUpdate({
        target: projectMenuSettings.project,
        set: { enabledViews: updated },
      });

    const rows = await db
      .select()
      .from(projectMenuSettings)
      .where(eq(projectMenuSettings.project, TEST_PROJECT));

    expect(rows).toHaveLength(1);
    expect(rows[0].enabledViews).toEqual(updated);
  });
});
