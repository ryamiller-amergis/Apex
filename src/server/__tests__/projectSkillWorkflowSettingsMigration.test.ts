import fs from 'node:fs';
import path from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { projectSkillSettings, projectSkillWorkflowSettings } from '../db/schema';
import {
  PROJECT_SKILL_WORKFLOWS,
  PROJECT_SKILL_WORKFLOW_FIELDS,
} from '../../shared/constants/projectSkillWorkflows';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20261027180000_c4d2_project-skill-workflow-settings.sql',
);

function splitMigration() {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const [upSql = '', downSql = ''] = sql.split(/-- Down Migration/i);
  return { upSql, downSql };
}

const snake = (field: string) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const legacyColumns = getTableColumns(projectSkillSettings);

/** `('workflow', s.col | NULL, …)` tuples from the backfill VALUES list. */
function backfillTuples(upSql: string): Map<string, string[]> {
  const block = upSql.match(/CROSS JOIN LATERAL \(VALUES([\s\S]*?)\) AS v\(/i)?.[1] ?? '';
  const tuples = new Map<string, string[]>();
  for (const [, key, rest] of block.matchAll(/\('([a-z_]+)',([^)]*)\)/g)) {
    tuples.set(key, rest.split(',').map((value) => value.trim()));
  }
  return tuples;
}

describe('project_skill_workflow_settings migration', () => {
  const { upSql, downSql } = splitMigration();

  it('creates the child table keyed by (settings_id, workflow) and cascading from the parent row', () => {
    expect(upSql).toMatch(/CREATE TABLE IF NOT EXISTS project_skill_workflow_settings/i);
    expect(upSql).toMatch(
      /settings_id UUID NOT NULL REFERENCES project_skill_settings\(id\) ON DELETE CASCADE/i,
    );
    expect(upSql).toMatch(/PRIMARY KEY \(settings_id, workflow\)/i);
  });

  it('never drops or alters a project_skill_settings column', () => {
    expect(upSql).not.toMatch(/ALTER TABLE project_skill_settings/i);
    expect(downSql).not.toMatch(/ALTER TABLE project_skill_settings/i);
    expect(upSql).not.toMatch(/UPDATE project_skill_settings/i);
    expect(downSql).not.toMatch(/DROP TABLE IF EXISTS project_skill_settings\b/i);
  });

  it('names the backfill columns in registry field order', () => {
    const alias = upSql.match(/\) AS v\(([^)]*)\)/i)?.[1] ?? '';
    expect(alias.split(',').map((name) => name.trim())).toEqual([
      'workflow',
      ...PROJECT_SKILL_WORKFLOW_FIELDS.map(snake),
    ]);
  });

  it('backfills each registry workflow from exactly the legacy columns the registry names', () => {
    const tuples = backfillTuples(upSql);
    expect([...tuples.keys()]).toEqual(PROJECT_SKILL_WORKFLOWS.map((workflow) => workflow.key));

    for (const workflow of PROJECT_SKILL_WORKFLOWS) {
      const legacy = workflow.legacy as Partial<Record<string, string>>;
      const expected = PROJECT_SKILL_WORKFLOW_FIELDS.map((field) => {
        const legacyField = legacy[field];
        return legacyField ? `s.${snake(legacyField)}` : 'NULL';
      });
      expect({ workflow: workflow.key, values: tuples.get(workflow.key) }).toEqual({
        workflow: workflow.key,
        values: expected,
      });
    }
  });

  it('copies only workflows with at least one override and keeps the parent updated_at', () => {
    expect(upSql).toMatch(/WHERE num_nonnulls\(/i);
    expect(upSql).toMatch(/b\.updated_at,\s*b\.updated_at/i);
  });

  it('reports any settings row whose workflow values did not copy', () => {
    expect(upSql).toMatch(/IS DISTINCT FROM/i);
    expect(upSql).toMatch(/RAISE WARNING 'project_skill_workflow_settings backfill: % settings row\(s\) did not copy: %'/);
  });

  it('rolls back by dropping only the child table', () => {
    expect(downSql.trim()).toBe('DROP TABLE IF EXISTS project_skill_workflow_settings;');
  });
});

describe('projectSkillWorkflowSettings Drizzle schema', () => {
  const { upSql } = splitMigration();

  it('matches the migration column list', () => {
    const createBody = upSql.match(
      /CREATE TABLE IF NOT EXISTS project_skill_workflow_settings \(([\s\S]*?)\n\);/i,
    )?.[1] ?? '';
    const migrationColumns = createBody
      .split('\n')
      .map((line) => line.trim().match(/^([a-z_]+) [A-Z]/)?.[1])
      .filter((name): name is string => Boolean(name));
    const schemaColumns = Object.values(getTableColumns(projectSkillWorkflowSettings)).map(
      (column) => column.name,
    );
    expect(schemaColumns).toEqual(migrationColumns);
  });

  it('uses the same primary key and cascading parent reference', () => {
    const config = getTableConfig(projectSkillWorkflowSettings);
    expect(config.primaryKeys[0].columns.map((column) => column.name)).toEqual([
      'settings_id',
      'workflow',
    ]);
    const reference = config.foreignKeys[0].reference();
    expect(reference.foreignTable).toBe(projectSkillSettings);
    expect(config.foreignKeys[0].onDelete).toBe('cascade');
  });

  it('stores workflow values in the child table, not on project_skill_settings', () => {
    const child = getTableColumns(projectSkillWorkflowSettings);
    expect(child.skillPath.columnType).toBe('PgText');
    expect(child.model.columnType).toBe('PgText');
    expect(child.effort.columnType).toBe('PgText');
    expect(child.bedrockMaxTokens.columnType).toBe('PgInteger');
    expect(child.scoreThreshold.columnType).toBe('PgInteger');
    expect(child.bedrockTemperature.columnType).toBe('PgReal');
    for (const workflow of PROJECT_SKILL_WORKFLOWS) {
      for (const legacyField of Object.values(workflow.legacy)) {
        expect(legacyColumns).not.toHaveProperty(legacyField as string);
      }
    }
  });
});
