import fs from 'node:fs';
import path from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { projectSkillSettings } from '../db/schema';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260918010000_requirements-phase-skill-config.sql',
);
const sharedTypesPath = path.resolve(
  process.cwd(),
  'src/shared/types/interview.ts',
);

describe('Requirements phase skill configuration contracts', () => {
  it('adds nullable Requirements phase config columns', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');
    const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

    expect(upSql).toMatch(
      /ALTER TABLE project_skill_settings[\s\S]*ADD COLUMN IF NOT EXISTS requirements_phase_skill_path TEXT[\s\S]*ADD COLUMN IF NOT EXISTS requirements_phase_model TEXT[\s\S]*ADD COLUMN IF NOT EXISTS requirements_phase_effort TEXT/i,
    );
    expect(upSql).not.toMatch(
      /requirements_phase_(?:skill_path|model|effort)[^,;]*NOT NULL/i,
    );
    expect(downSql).toMatch(
      /ALTER TABLE project_skill_settings[\s\S]*DROP COLUMN IF EXISTS requirements_phase_effort[\s\S]*DROP COLUMN IF EXISTS requirements_phase_model[\s\S]*DROP COLUMN IF EXISTS requirements_phase_skill_path/i,
    );
  });

  it('keeps the Drizzle schema aligned with the migration', () => {
    expect(Object.keys(getTableColumns(projectSkillSettings))).toEqual(
      expect.arrayContaining([
        'requirementsPhaseSkillPath',
        'requirementsPhaseModel',
        'requirementsPhaseEffort',
      ]),
    );
  });

  it('exposes the bundled skill as a fallback rather than a hardcoded path', () => {
    const source = fs.readFileSync(sharedTypesPath, 'utf8');

    expect(source).toMatch(
      /export const DEFAULT_REQUIREMENTS_PHASE_SKILL\s*=/,
    );
    expect(source).toMatch(/configuredSkillPath\?:\s*string\s*\|\s*null/);
  });
});
