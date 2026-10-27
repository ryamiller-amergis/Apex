import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema';

/**
 * Drizzle loads a relation by passing every column to one Postgres function, and
 * Postgres rejects more than 100 arguments (error 54023). Keep tables well under that.
 */
const MAX_TABLE_COLUMNS = 50;

/**
 * project_skill_settings predates the cap. Its per-workflow columns are being moved
 * to project_skill_workflow_settings (design-docs/project-skill-settings-normalization.plan.md).
 * These ceilings may only go down; lower them when the contract migration drops columns.
 */
const PROJECT_SKILL_SETTINGS_COLUMN_CEILING = 110;
const PROJECT_SKILL_SETTINGS_WORKFLOW_COLUMN_CEILING = 77;

const workflowColumnPattern = /(_skill_path|_model|_effort|_bedrock_[a-z_]+|_score_threshold)$/;
const projectWideColumns = new Set(['default_model', 'default_effort']);

function tableWidths(): Array<{ name: string; columns: string[] }> {
  return Object.values(schema)
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => ({
      name: getTableName(table),
      columns: Object.values(getTableColumns(table)).map((column) => column.name),
    }));
}

describe('schema table width', () => {
  it(`keeps every table at ${MAX_TABLE_COLUMNS} columns or fewer`, () => {
    const tooWide = tableWidths()
      .filter((table) => table.name !== 'project_skill_settings')
      .filter((table) => table.columns.length > MAX_TABLE_COLUMNS)
      .map((table) => `${table.name} (${table.columns.length})`);

    expect(tooWide).toEqual([]);
  });

  it('does not let project_skill_settings grow', () => {
    const table = tableWidths().find((t) => t.name === 'project_skill_settings');
    expect(table).toBeDefined();
    expect(table!.columns.length).toBeLessThanOrEqual(PROJECT_SKILL_SETTINGS_COLUMN_CEILING);
  });

  it('adds no per-workflow column to project_skill_settings; new workflows go in PROJECT_SKILL_WORKFLOWS', () => {
    const table = tableWidths().find((t) => t.name === 'project_skill_settings');
    const workflowColumns = table!.columns.filter(
      (name) => workflowColumnPattern.test(name) && !projectWideColumns.has(name),
    );
    expect(workflowColumns.length).toBeLessThanOrEqual(PROJECT_SKILL_SETTINGS_WORKFLOW_COLUMN_CEILING);
  });
});
