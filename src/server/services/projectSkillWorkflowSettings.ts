import { getTableName, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { projectSkillSettings, projectSkillWorkflowSettings } from '../db/schema';
import {
  PROJECT_SKILL_WORKFLOWS,
  PROJECT_SKILL_WORKFLOW_FIELDS,
  type ProjectSkillWorkflowSettings,
} from '../../shared/constants/projectSkillWorkflows';

/** A child row as returned by {@link workflowSettingsSubquery}. */
export type StoredWorkflowSettings = ProjectSkillWorkflowSettings & { workflow: string };

/**
 * Correlated subquery that loads a settings row's workflow rows as one JSON
 * array, so readers keep a single `select` on the parent table.
 *
 * While the legacy columns are still written, a row older than its parent row
 * was left behind by app code that only writes the legacy columns; it is
 * skipped and the reader falls back to those columns.
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
      and ${child(projectSkillWorkflowSettings.updatedAt)} >= ${parent(projectSkillSettings.updatedAt)}
  )`;
}

/**
 * Overlays child-row values onto the flat legacy fields. A workflow with a
 * child row owns every field it maps, nulls included; a workflow without one
 * keeps the legacy column values. For the shared ADR fields the first ADR
 * workflow with a row wins.
 */
export function withWorkflowSettings<Row extends Record<string, unknown>>(
  row: Row,
  workflowRows: StoredWorkflowSettings[] | null | undefined,
): Row {
  if (!workflowRows?.length) return row;
  const byWorkflow = new Map(workflowRows.map((child) => [child.workflow, child]));
  const merged: Record<string, unknown> = { ...row };
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
