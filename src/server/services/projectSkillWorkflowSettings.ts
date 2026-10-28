import { and, eq, getTableName, inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { db } from '../db/drizzle';
import { projectSkillSettings, projectSkillWorkflowSettings } from '../db/schema';
import {
  PROJECT_SKILL_WORKFLOWS,
  PROJECT_SKILL_WORKFLOW_FIELDS,
  isEmptyWorkflowSettings,
  legacyWorkflowFields,
  workflowSettingsFromLegacy,
  type ProjectSkillWorkflowSettings,
} from '../../shared/constants/projectSkillWorkflows';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';

/** A child row as returned by {@link workflowSettingsSubquery}. */
export type StoredWorkflowSettings = ProjectSkillWorkflowSettings & { workflow: string };

/**
 * Correlated subquery that loads a settings row's workflow rows as one JSON
 * array, so readers keep a single `select` on the parent table.
 *
 * The per-workflow columns are gone, so this is the only copy of those values.
 */
export function workflowSettingsSubquery(): SQL<StoredWorkflowSettings[] | null> {
  // Drizzle drops table qualifiers inside a single-table select, which would
  // bind both sides of each comparison to the child table. Qualify by hand.
  const child = (column: AnyColumn) => sql`${sql.identifier('w')}.${sql.identifier(column.name)}`;
  const parent = (column: AnyColumn) =>
    sql`${sql.identifier(getTableName(projectSkillSettings))}.${sql.identifier(column.name)}`;
  const fields = sql.join(
    [
      sql`'workflow', ${child(projectSkillWorkflowSettings.workflow)}`,
      ...PROJECT_SKILL_WORKFLOW_FIELDS.map(
        (field) => sql`${sql.raw(`'${field}'`)}, ${child(projectSkillWorkflowSettings[field])}`,
      ),
    ],
    sql`, `,
  );
  return sql<StoredWorkflowSettings[] | null>`(
    select json_agg(json_build_object(${fields}))
    from ${projectSkillWorkflowSettings} ${sql.identifier('w')}
    where ${child(projectSkillWorkflowSettings.settingsId)} = ${parent(projectSkillSettings.id)}
  )`;
}

type WorkflowWriter = Pick<typeof db, 'insert' | 'delete' | 'select'>;

/** Parent-table writes must not mention the dropped per-workflow columns. */
export function omitWorkflowColumns<T extends Record<string, unknown>>(row: T): T {
  const copy = { ...row };
  for (const field of legacyWorkflowFields()) delete copy[field];
  return copy;
}

/**
 * Writes the incoming workflow fields and keeps child-row values for fields
 * the caller does not send. Standup's skill path is one of those: the project
 * settings form does not edit it.
 */
export async function saveWorkflowSettings(
  tx: WorkflowWriter,
  settingsId: string,
  incoming: Partial<Record<string, unknown>>,
  updatedAt: string,
): Promise<void> {
  const existing = await tx
    .select()
    .from(projectSkillWorkflowSettings)
    .where(eq(projectSkillWorkflowSettings.settingsId, settingsId));
  const merged = withWorkflowSettings({} as Record<string, unknown>, existing as StoredWorkflowSettings[]);
  for (const field of legacyWorkflowFields()) {
    if (Object.prototype.hasOwnProperty.call(incoming, field)) {
      merged[field] = incoming[field] ?? null;
    }
  }
  await writeWorkflowSettings(tx, { id: settingsId, ...merged }, updatedAt);
}

/**
 * Mirrors a just-written settings row into its child rows. Runs inside the
 * caller's transaction and reads from the saved row, so columns the caller
 * did not set (for example the standup path) are mirrored too. `updatedAt`
 * must equal the parent row's so readers treat the rows as current.
 */
export async function writeWorkflowSettings(
  tx: WorkflowWriter,
  row: { id: string } & Partial<Record<keyof ProjectSkillConfig, unknown>>,
  updatedAt: string,
): Promise<void> {
  const filled: Array<typeof projectSkillWorkflowSettings.$inferInsert> = [];
  const emptyWorkflows: string[] = [];
  for (const workflow of PROJECT_SKILL_WORKFLOWS) {
    const settings = workflowSettingsFromLegacy(workflow, row);
    if (isEmptyWorkflowSettings(settings)) {
      emptyWorkflows.push(workflow.key);
    } else {
      filled.push({ settingsId: row.id, workflow: workflow.key, ...settings, updatedAt });
    }
  }

  if (emptyWorkflows.length > 0) {
    await tx
      .delete(projectSkillWorkflowSettings)
      .where(
        and(
          eq(projectSkillWorkflowSettings.settingsId, row.id),
          inArray(projectSkillWorkflowSettings.workflow, emptyWorkflows),
        ),
      );
  }
  if (filled.length > 0) {
    const excluded = Object.fromEntries(
      [...PROJECT_SKILL_WORKFLOW_FIELDS, 'updatedAt' as const].map((field) => [
        field,
        sql.raw(`excluded.${projectSkillWorkflowSettings[field].name}`),
      ]),
    );
    await tx
      .insert(projectSkillWorkflowSettings)
      .values(filled)
      .onConflictDoUpdate({
        target: [projectSkillWorkflowSettings.settingsId, projectSkillWorkflowSettings.workflow],
        set: excluded,
      });
  }
}

/**
 * Overlays child-row values onto the flat fields the rest of the app reads.
 * A workflow with a child row owns every field it maps, nulls included.
 * A workflow with no row leaves that field null. For the shared ADR fields
 * the first ADR workflow with a row wins.
 */
export function withWorkflowSettings<Row extends Record<string, unknown>>(
  row: Row,
  workflowRows: StoredWorkflowSettings[] | null | undefined,
): Row {
  const merged: Record<string, unknown> = { ...row };
  for (const field of legacyWorkflowFields()) {
    if (!Object.prototype.hasOwnProperty.call(merged, field)) merged[field] = null;
  }
  if (!workflowRows?.length) return merged as Row;
  const byWorkflow = new Map(workflowRows.map((child) => [child.workflow, child]));
  const resolved = new Set<string>();
  for (const workflow of PROJECT_SKILL_WORKFLOWS) {
    const child = byWorkflow.get(workflow.key);
    if (!child) continue;
    for (const [field, legacyField] of Object.entries(workflow.legacy)) {
      if (resolved.has(legacyField)) continue;
      merged[legacyField] = child[field as keyof ProjectSkillWorkflowSettings] ?? null;
      resolved.add(legacyField);
    }
  }
  return merged as Row;
}
