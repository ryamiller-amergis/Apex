import fs from 'node:fs';
import path from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { playbookRuns } from '../db/schema';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260922180000_add-playbook-run-input.sql',
);

describe('FEAT-014 playbook run input migration', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

  it('adds nullable JSONB run_input on playbook_runs', () => {
    expect(upSql).toMatch(/ALTER TABLE playbook_runs/i);
    expect(upSql).toMatch(/ADD COLUMN run_input jsonb/i);
    expect(downSql).toMatch(/DROP COLUMN run_input/i);
  });

  it('mirrors the column in Drizzle', () => {
    const columns = getTableColumns(playbookRuns);
    expect(columns.runInput.name).toBe('run_input');
  });
});
