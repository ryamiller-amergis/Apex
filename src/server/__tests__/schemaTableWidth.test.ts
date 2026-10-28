import { getTableColumns, getTableName } from 'drizzle-orm';
import * as schema from '../db/schema';

/**
 * Drizzle loads a relation by passing every column to one Postgres function, and
 * Postgres rejects more than 100 arguments (error 54023). Keep tables well under that.
 */
const MAX_TABLE_COLUMNS = 50;

/**
 * project_skill_settings keeps the fields that are set once per project. Per-workflow
 * values live in project_skill_workflow_settings. These ceilings may only go down.
 */
const PROJECT_SKILL_SETTINGS_COLUMN_CEILING = 33;
const PROJECT_SKILL_SETTINGS_WORKFLOW_COLUMN_CEILING = 0;

const workflowColumnPattern = /(_skill_path|_model|_effort|_bedrock_[a-z_]+|_score_threshold)$/;
const projectWideColumns = new Set(['default_model', 'default_effort']);

type ColumnTable = Parameters<typeof getTableColumns>[0];
type NamedTable = Parameters<typeof getTableName>[0];

function readTable(value: unknown): { name: string; columns: string[] } | null {
  if (value === null || typeof value !== 'object') return null;
  try {
    const name = getTableName(value as NamedTable);
    if (typeof name !== 'string' || name.length === 0) return null;
    const columns = Object.values(getTableColumns(value as ColumnTable)).map((column) => column.name);
    return columns.length === 0 ? null : { name, columns };
  } catch {
    return null;
  }
}

function tableWidths(): Array<{ name: string; columns: string[] }> {
  return Object.values(schema).flatMap((value) => {
    const table = readTable(value);
    return table ? [table] : [];
  });
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
