import { eq, asc } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { projectMenuSettings } from '../db/schema';
import type { ProjectMenuConfig, MenuItemKey } from '../../shared/types/menuSettings';

export async function getMenuConfig(project: string): Promise<ProjectMenuConfig | null> {
  const rows = await db
    .select()
    .from(projectMenuSettings)
    .where(eq(projectMenuSettings.project, project));

  const row = rows[0];
  if (!row) return null;

  return {
    project: row.project,
    enabledViews: row.enabledViews,
    updatedBy: row.updatedBy,
  };
}

export async function listMenuConfigs(): Promise<ProjectMenuConfig[]> {
  const rows = await db
    .select()
    .from(projectMenuSettings)
    .orderBy(asc(projectMenuSettings.project));

  return rows.map((row) => ({
    project: row.project,
    enabledViews: row.enabledViews,
    updatedBy: row.updatedBy,
  }));
}

export async function upsertMenuConfig(
  project: string,
  enabledViews: MenuItemKey[],
  updatedBy: string,
): Promise<ProjectMenuConfig> {
  const rows = await db
    .insert(projectMenuSettings)
    .values({ project, enabledViews, updatedBy })
    .onConflictDoUpdate({
      target: projectMenuSettings.project,
      set: {
        enabledViews,
        updatedBy,
        updatedAt: new Date().toISOString(),
      },
    })
    .returning();

  const row = rows[0];
  return {
    project: row.project,
    enabledViews: row.enabledViews,
    updatedBy: row.updatedBy,
  };
}
