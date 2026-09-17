import fs from 'node:fs';
import path from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { interviews, projectSkillSettings } from '../db/schema';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260917150000_technical-phase-contracts.sql',
);
const sharedTypesPath = path.resolve(
  process.cwd(),
  'src/shared/types/interview.ts',
);

describe('FEAT-005 Wave 1 S1/S3 technical phase contracts', () => {
  it('S1 / TBI-005 DoD-0 adds nullable technical phase config and thread columns', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');
    const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

    expect(upSql).toMatch(
      /ALTER TABLE project_skill_settings[\s\S]*ADD COLUMN IF NOT EXISTS technical_phase_skill_path TEXT[\s\S]*ADD COLUMN IF NOT EXISTS technical_phase_model TEXT[\s\S]*ADD COLUMN IF NOT EXISTS technical_phase_effort TEXT/i,
    );
    expect(upSql).toMatch(
      /ALTER TABLE interviews[\s\S]*ADD COLUMN IF NOT EXISTS technical_phase_chat_thread_id UUID\s+REFERENCES chat_threads\(id\) ON DELETE SET NULL/i,
    );
    expect(upSql).not.toMatch(/technical_phase_(?:skill_path|model|effort)[^,;]*NOT NULL/i);
    expect(upSql).not.toMatch(/technical_phase_chat_thread_id[^,;]*NOT NULL/i);
    expect(downSql).toMatch(
      /ALTER TABLE interviews\s+DROP COLUMN IF EXISTS technical_phase_chat_thread_id/i,
    );
    expect(downSql).toMatch(
      /ALTER TABLE project_skill_settings[\s\S]*DROP COLUMN IF EXISTS technical_phase_effort[\s\S]*DROP COLUMN IF EXISTS technical_phase_model[\s\S]*DROP COLUMN IF EXISTS technical_phase_skill_path/i,
    );
  });

  it('S1 keeps the Drizzle schema aligned with the migration', () => {
    expect(Object.keys(getTableColumns(projectSkillSettings))).toEqual(
      expect.arrayContaining([
        'technicalPhaseSkillPath',
        'technicalPhaseModel',
        'technicalPhaseEffort',
      ]),
    );
    expect(Object.keys(getTableColumns(interviews))).toContain(
      'technicalPhaseChatThreadId',
    );
  });

  it('S3 exposes the Technical Phase shared contracts and Interview summary thread id', () => {
    const source = fs.readFileSync(sharedTypesPath, 'utf8');

    expect(source).toMatch(/export type TechnicalPhaseStatus\s*=/);
    expect(source).toMatch(/export interface TechnicalPhaseSeedContext\s*\{/);
    expect(source).toMatch(/export interface TechnicalPhaseState\s*\{/);
    expect(source).toMatch(/export interface StartTechnicalPhaseResponse\s*\{/);
    expect(source).toMatch(
      /technicalPhaseChatThreadId\?:\s*string\s*\|\s*null;/,
    );
  });
});
