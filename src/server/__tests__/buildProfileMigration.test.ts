import fs from 'fs';
import path from 'path';

const sql = fs.readFileSync(
  path.resolve(__dirname, '../../../migrations/20261026200000_f3a1_project-skill-settings-build-profile.sql'),
  'utf8',
);
const [up, down = ''] = sql.split('-- Down Migration');

describe('TBI-005 DoD-0 — build profile migration (VT-33)', () => {
  it('adds three nullable columns to project_skill_settings without touching existing rows', () => {
    expect(up).toMatch(/ALTER TABLE project_skill_settings/);
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS build_profile jsonb,/);
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS build_profile_updated_at timestamptz/);
    expect(up).toMatch(/ADD COLUMN IF NOT EXISTS build_profile_updated_by text/);
    expect(up).not.toMatch(/NOT NULL|DEFAULT|UPDATE |INSERT /);
  });

  it('rejects a non-object build_profile value', () => {
    expect(up).toMatch(/CHECK \(build_profile IS NULL OR jsonb_typeof\(build_profile\) = 'object'\)/);
  });

  it('down removes the constraint and all three columns', () => {
    expect(down).toMatch(/DROP CONSTRAINT IF EXISTS project_skill_settings_build_profile_object_check/);
    for (const column of ['build_profile_updated_by', 'build_profile_updated_at', 'build_profile']) {
      expect(down).toMatch(new RegExp(`DROP COLUMN IF EXISTS ${column}[,;]`));
    }
  });
});
