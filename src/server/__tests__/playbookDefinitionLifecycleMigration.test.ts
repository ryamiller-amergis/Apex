/**
 * FEAT-007 / S2 — definition lifecycle migration + Drizzle storage contract.
 *
 * Bound to TBI-030 / TBI-031 and VT-09..VT-11 (tech-spec Verification Test Matrix).
 * Contract-source tests so RED fails before the migration and schema columns exist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { playbookDefinitionVersions, playbookRuns } from '../db/schema';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260922110000_playbook-definition-lifecycle.sql',
);
const schemaPath = path.resolve(process.cwd(), 'src/server/db/schema.ts');
const definitionServicePath = path.resolve(
  process.cwd(),
  'src/server/services/playbookDefinitionService.ts',
);

describe('FEAT-007 S2 — playbook definition lifecycle migration (TBI-030 / TBI-031)', () => {
  it('migration file exists at the FEAT-007 lifecycle path', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  const migration = fs.existsSync(migrationPath)
    ? fs.readFileSync(migrationPath, 'utf8')
    : '';
  const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);
  const schemaSource = fs.readFileSync(schemaPath, 'utf8');

  it('VT-10 / TBI-030 — backfills one retained draft from the highest version graph (or empty)', () => {
    expect(upSql).toMatch(/INSERT\s+INTO\s+playbook_definition_versions/i);
    expect(upSql).toMatch(/status\s*=\s*'draft'/i);
    expect(upSql).toMatch(/MAX\s*\(\s*(?:v\.)?version_number\s*\)/i);
    expect(upSql).toMatch(/ORDER BY[\s\S]*version_number[\s\S]*DESC/i);
    expect(upSql).toMatch(/\{\s*"nodes"\s*:\s*\[\s*\]\s*,\s*"edges"\s*:\s*\[\s*\]\s*\}/);
    expect(upSql).toMatch(
      /NOT EXISTS[\s\S]*playbook_definition_versions[\s\S]*status\s*=\s*'draft'/i,
    );
  });

  it('VT-11 / TBI-030 — precondition then partial unique index uq_playbook_definition_versions_one_draft', () => {
    expect(upSql).toMatch(/RAISE\s+EXCEPTION/i);
    expect(upSql).toMatch(/HAVING\s+COUNT\s*\(\s*\*\s*\)\s*>\s*1/i);
    expect(upSql).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?uq_playbook_definition_versions_one_draft/i,
    );
    expect(upSql).toMatch(
      /ON\s+playbook_definition_versions\s*\(\s*definition_id\s*\)[\s\S]*WHERE\s+status\s*=\s*'draft'/i,
    );
  });

  it('TBI-030 / TBI-031 — adds updated_at and version_pin_reason additively', () => {
    expect(upSql).toMatch(
      /ALTER\s+TABLE\s+playbook_definition_versions[\s\S]*ADD\s+COLUMN[\s\S]*updated_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i,
    );
    expect(upSql).toMatch(
      /ALTER\s+TABLE\s+playbook_runs[\s\S]*ADD\s+COLUMN[\s\S]*version_pin_reason\s+TEXT/i,
    );
  });

  it('VT-09 / TBI-030 (d) — retains restrict FK semantics and exposes no hard-delete API', () => {
    expect(upSql).not.toMatch(/ON\s+DELETE\s+CASCADE/i);
    expect(upSql).not.toMatch(/DROP\s+CONSTRAINT[\s\S]*definition_version/i);
    expect(downSql).not.toMatch(/DELETE\s+FROM\s+playbook_definition_versions/i);

    const service = fs.readFileSync(definitionServicePath, 'utf8');
    expect(service).not.toMatch(/export\s+(?:async\s+)?function\s+delete(?:Version|Definition)\b/);
    expect(service).not.toMatch(/export\s+(?:async\s+)?function\s+hardDelete\w*\b/);
  });

  it('reversible down drops index and additive columns without deleting backfilled drafts', () => {
    expect(downSql).toMatch(
      /DROP\s+INDEX\s+IF\s+EXISTS\s+uq_playbook_definition_versions_one_draft/i,
    );
    expect(downSql).toMatch(
      /ALTER\s+TABLE\s+playbook_runs[\s\S]*DROP\s+COLUMN\s+IF\s+EXISTS\s+version_pin_reason/i,
    );
    expect(downSql).toMatch(
      /ALTER\s+TABLE\s+playbook_definition_versions[\s\S]*DROP\s+COLUMN\s+IF\s+EXISTS\s+updated_at/i,
    );
    expect(downSql).not.toMatch(/DELETE\s+FROM\s+playbook_definition_versions/i);
    expect(downSql).not.toMatch(/DELETE\s+FROM\s+playbook_definitions/i);
  });

  it('Drizzle schema mirrors updated_at, version_pin_reason, and the one-draft index', () => {
    const versionCols = getTableColumns(playbookDefinitionVersions);
    expect(versionCols.updatedAt?.name).toBe('updated_at');

    const runCols = getTableColumns(playbookRuns);
    expect(runCols.versionPinReason?.name).toBe('version_pin_reason');

    expect(schemaSource).toMatch(/uq_playbook_definition_versions_one_draft/);
    expect(schemaSource).toMatch(/\$\{t\.status\}\s*=\s*'draft'/);
  });
});
