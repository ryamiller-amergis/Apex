/**
 * Migration contract checks for per-module approval-mode storage (TBI-001).
 * Asserts the additive project_approval_modes DDL, the cutover back-fill, the
 * widened reviewer-pool CHECK constraints, and the matching Drizzle schema.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { projectApprovalModes, projectApprovalModesRelations } from '../db/schema';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260828010000_project-approval-modes.sql',
);

describe('TBI-001 per-module approval mode migration', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

  it('VT-07 creates project_approval_modes with cascade FK, unique key, and validated module/mode values', () => {
    expect(upSql).toMatch(/CREATE TABLE IF NOT EXISTS project_approval_modes/i);
    expect(upSql).toMatch(/id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
    expect(upSql).toMatch(
      /settings_id UUID NOT NULL REFERENCES project_skill_settings\(id\) ON DELETE CASCADE/i,
    );
    expect(upSql).toMatch(
      /document_type TEXT NOT NULL CHECK \(document_type IN \('prd', 'design_doc', 'design_prototype', 'test_case', 'adr'\)\)/i,
    );
    expect(upSql).toMatch(/mode TEXT NOT NULL CHECK \(mode IN \('any_one', 'all_required'\)\)/i);
    expect(upSql).toMatch(/updated_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/i);
    expect(upSql).toMatch(/UNIQUE \(settings_id, document_type\)/i);
  });

  it('VT-07 retains the legacy project_skill_settings.approval_mode column', () => {
    expect(upSql).not.toMatch(/DROP COLUMN[\s\S]*approval_mode/i);
    expect(upSql).not.toMatch(/ALTER TABLE project_skill_settings[\s\S]*approval_mode[\s\S]*DROP/i);
    expect(upSql).not.toMatch(/UPDATE project_skill_settings/i);
  });

  it('DoD-2 / VT-07 cutover copies the legacy mode onto four modules and forces adr to any_one', () => {
    expect(upSql).toMatch(
      /INSERT INTO project_approval_modes \(settings_id, document_type, mode\)/i,
    );
    expect(upSql).toMatch(/FROM project_skill_settings s/i);
    expect(upSql).toMatch(
      /CASE\s+WHEN m\.document_type = 'adr' THEN 'any_one'[\s\S]*ELSE COALESCE\(s\.approval_mode, 'any_one'\)\s*END/i,
    );
    expect(upSql).toMatch(
      /VALUES \('prd'\), \('design_doc'\), \('design_prototype'\), \('test_case'\), \('adr'\)/i,
    );
  });

  it('DoD-2 cutover is idempotent and never overwrites an existing per-module row', () => {
    expect(upSql).toMatch(/ON CONFLICT \(settings_id, document_type\) DO NOTHING/i);
    expect(upSql).not.toMatch(/ON CONFLICT[\s\S]*DO UPDATE/i);
  });

  it('DoD-3 / VT-13 leaves existing reviewer-pool rows untouched (no adr pool seeding)', () => {
    expect(upSql).not.toMatch(/INSERT INTO project_approvers/i);
    expect(upSql).not.toMatch(/INSERT INTO project_approver_groups/i);
    expect(upSql).not.toMatch(/UPDATE project_approvers/i);
    expect(upSql).not.toMatch(/UPDATE project_approver_groups/i);
    expect(upSql).not.toMatch(/DELETE FROM project_approvers/i);
    expect(upSql).not.toMatch(/DELETE FROM project_approver_groups/i);
  });

  it('DoD-0 (enabling) widens the reviewer-pool document_type constraints to include adr', () => {
    expect(upSql).toMatch(
      /ALTER TABLE project_approvers\s+ADD CONSTRAINT project_approvers_document_type_check\s+CHECK \(document_type IN \('design_doc', 'prd', 'design_prototype', 'test_case', 'adr'\)\)/i,
    );
    expect(upSql).toMatch(
      /ALTER TABLE project_approver_groups\s+ADD CONSTRAINT project_approver_groups_document_type_check\s+CHECK \(document_type IN \('design_doc', 'prd', 'design_prototype', 'test_case', 'adr'\)\)/i,
    );
    expect(upSql).toMatch(
      /ALTER TABLE project_approvers\s+DROP CONSTRAINT IF EXISTS project_approvers_document_type_check/i,
    );
    expect(upSql).toMatch(
      /ALTER TABLE project_approver_groups\s+DROP CONSTRAINT IF EXISTS project_approver_groups_document_type_check/i,
    );
  });

  it('VT-13 down drops only the additive table and restores the four-module pool constraints', () => {
    expect(migration).toMatch(/^-- Down Migration\s*$/m);
    expect(downSql).toMatch(/DROP TABLE IF EXISTS project_approval_modes/i);
    expect(downSql).toMatch(
      /CHECK \(document_type IN \('design_doc', 'prd', 'design_prototype', 'test_case'\)\)/i,
    );
    expect(downSql).not.toMatch(/DROP TABLE IF EXISTS project_skill_settings/i);
    expect(downSql).not.toMatch(/DROP TABLE IF EXISTS project_approvers/i);
    expect(downSql).not.toMatch(/DROP TABLE IF EXISTS project_approver_groups/i);
    expect(downSql).not.toMatch(/DROP COLUMN[\s\S]*approval_mode/i);
  });

  it('DoD-1 (enabling) Drizzle schema exposes projectApprovalModes matching the migration', () => {
    expect(getTableName(projectApprovalModes)).toBe('project_approval_modes');
    expect(Object.keys(getTableColumns(projectApprovalModes))).toEqual(
      expect.arrayContaining(['id', 'settingsId', 'documentType', 'mode', 'updatedAt']),
    );
    expect(projectApprovalModesRelations).toBeDefined();
  });
});
